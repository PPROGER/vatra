// Bridges browser terminals to tmux sessions. One node-pty per task runs
// `tmux attach`; every browser tab for that task shares it.
import * as pty from 'node-pty';
import { cleanEnv, type Tmux } from './tmux.js';

export interface TerminalClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(s: string) {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    if (this.size > this.max) {
      const only = this.chunks[0];
      this.chunks[0] = only.slice(only.length - this.max);
      this.size = this.chunks[0].length;
    }
  }
  toString() {
    return this.chunks.join('');
  }
  clear() {
    this.chunks = [];
    this.size = 0;
  }
}

// Terminal queries (device attributes, cursor position, colours, XTVERSION, XTGETTCAP).
// Replaying them from the backlog makes a fresh xterm.js answer again, and the stale
// answers would be typed into claude as garbage like "^[[?1;2c".
const QUERY_RE = /\x1b\[[>=]?0?c|\x1b\[\??6n|\x1b\[>q|\x1b\[\?u|\x1b\](?:1[0-2]|4;\d+);\?(?:\x07|\x1b\\)|\x1bP\+q[0-9a-fA-F;]*\x1b\\/g;
// Answers to those queries coming from the browser.
const RESPONSE_RE = /\x1b\[[?>=][\d;]*c|\x1b\[\d+;\d+R|\x1b\](?:1[0-2]|4;\d+);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1bP[>!|][\s\S]*?\x1b\\|\x1b\[\?\d+u/g;
const RESPONSE_WINDOW_MS = 2000;

interface Bridge {
  taskId: number;
  session: string;
  term: pty.IPty | null;
  ring: RingBuffer;
  clients: Set<TerminalClient>;
  lastClientAt: number;
  cols: number;
  rows: number;
  closing: boolean;
  respawnTimer?: NodeJS.Timeout;
}

export class TerminalHub {
  private bridges = new Map<number, Bridge>();
  /** Raw output listener (used to spot dialogs that happen before hooks work, e.g. folder trust). */
  onOutput: ((taskId: number, chunk: string) => void) | null = null;

  constructor(
    private readonly tmux: Tmux,
    private readonly ringBytes: number,
  ) {}

  private spawn(b: Bridge) {
    const term = pty.spawn('tmux', [...this.tmux.baseArgs(), 'attach-session', '-t', `=${b.session}`], {
      name: 'xterm-256color',
      cols: b.cols,
      rows: b.rows,
      cwd: process.env.HOME || '/',
      env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }) as Record<string, string>,
    });
    b.term = term;
    term.onData((d) => {
      b.ring.push(d);
      this.onOutput?.(b.taskId, d);
      for (const c of b.clients) c.send(d);
    });
    term.onExit(() => {
      if (b.term === term) b.term = null;
      if (b.closing) return;
      // tmux client died (server restart, session killed…). Re-attach if the session still exists.
      b.respawnTimer = setTimeout(async () => {
        if (b.closing) return;
        const p = await this.tmux.pane(b.session).catch(() => null);
        if (p?.exists) this.spawn(b);
        else this.close(b.taskId, 'session ended');
      }, 500);
    });
  }

  /** Attach (or reuse) the bridge for a task. Caller must ensure the tmux session exists. */
  ensure(taskId: number, session: string): void {
    let b = this.bridges.get(taskId);
    if (b && b.session === session) {
      if (!b.term && !b.respawnTimer) this.spawn(b);
      return;
    }
    if (b) this.close(taskId);
    b = { taskId, session, term: null, ring: new RingBuffer(this.ringBytes), clients: new Set(), lastClientAt: 0, cols: 120, rows: 36, closing: false };
    this.bridges.set(taskId, b);
    this.spawn(b);
  }

  has(taskId: number): boolean {
    return this.bridges.has(taskId);
  }

  addClient(taskId: number, client: TerminalClient): boolean {
    const b = this.bridges.get(taskId);
    if (!b) return false;
    const backlog = b.ring.toString().replace(QUERY_RE, '');
    if (backlog) client.send(backlog);
    b.clients.add(client);
    b.lastClientAt = Date.now();
    return true;
  }

  removeClient(taskId: number, client: TerminalClient): void {
    this.bridges.get(taskId)?.clients.delete(client);
  }

  write(taskId: number, data: string): void {
    const b = this.bridges.get(taskId);
    if (!b?.term) return;
    if (Date.now() - b.lastClientAt < RESPONSE_WINDOW_MS) {
      data = data.replace(RESPONSE_RE, '');
      if (!data) return;
    }
    b.term.write(data);
  }

  resize(taskId: number, cols: number, rows: number): void {
    const b = this.bridges.get(taskId);
    if (!b || !b.term) return;
    cols = Math.max(20, Math.min(500, Math.floor(cols)));
    rows = Math.max(5, Math.min(200, Math.floor(rows)));
    if (cols === b.cols && rows === b.rows) {
      // Same size: wiggle it so tmux repaints the whole screen for the new viewer.
      b.term.resize(cols, Math.max(5, rows - 1));
    }
    b.cols = cols;
    b.rows = rows;
    const term = b.term;
    setTimeout(() => {
      try {
        term.resize(cols, rows);
      } catch {
        /* exited */
      }
    }, 30);
  }

  /** Drop the bridge and disconnect its clients. Does not touch the tmux session. */
  close(taskId: number, reason = 'closed'): void {
    const b = this.bridges.get(taskId);
    if (!b) return;
    b.closing = true;
    clearTimeout(b.respawnTimer);
    try {
      b.term?.kill();
    } catch {
      /* already dead */
    }
    for (const c of b.clients) c.close(1000, reason);
    this.bridges.delete(taskId);
  }

  closeAll(): void {
    for (const id of [...this.bridges.keys()]) this.close(id, 'server shutdown');
  }
}
