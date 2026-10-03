// Working without hooks: some Claude Code setups never run the hooks Vatra registers
// (managed policies, settings sources, …). Then the task state is read from what claude
// writes anyway — its transcript under ~/.claude/projects — and from the screen.
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** Claude Code keeps transcripts in projects/<cwd with every non-alphanumeric char → '-'>. */
export function transcriptDirKey(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* keep as is */
  }
  return real.replace(/[^A-Za-z0-9]/g, '-');
}

/** Newest transcript of a worktree written at or after `sinceMs`. */
export function findTranscript(cwd: string, sinceMs: number): string | null {
  const root = claudeProjectsDir();
  const key = transcriptDirKey(cwd);
  const dirs = [join(root, key)];
  // very long paths are truncated and get a hash suffix
  if (key.length > 200) {
    try {
      for (const d of readdirSync(root)) if (d !== key && d.startsWith(key.slice(0, 200))) dirs.push(join(root, d));
    } catch {
      /* no projects dir yet */
    }
  }
  let best: string | null = null;
  let bestM = 0;
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const m = statSync(join(d, f)).mtimeMs;
        if (m >= sinceMs - 2000 && m > bestM) {
          best = join(d, f);
          bestM = m;
        }
      } catch {
        /* vanished */
      }
    }
  }
  return best;
}

export interface TurnState {
  /** running = claude is working on a turn, idle = the turn is over and it waits for you. */
  state: 'running' | 'idle' | null;
  /** Tool in progress (last tool_use of the running turn). */
  tool: { name: string; input: Record<string, unknown> } | null;
  /** ms since the transcript was last written. */
  quietMs: number;
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
      : '';

/** Reads the end of a transcript and tells whether the current turn is still going. */
export function turnState(file: string, nowMs = Date.now()): TurnState {
  let quietMs = 0;
  let lines: string[];
  try {
    quietMs = nowMs - statSync(file).mtimeMs;
    lines = tail(file, 256 * 1024).split('\n');
  } catch {
    return { state: null, tool: null, quietMs };
  }
  const settled = quietMs > 4000;
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(raw);
    } catch {
      continue; // partial first line of the tail, or a line being written
    }
    if (d.isSidechain) continue;
    if (d.type === 'system') {
      if (d.subtype === 'turn_duration') return { state: 'idle', tool: null, quietMs };
      if (d.subtype === 'local_command') return { state: 'idle', tool: null, quietMs };
      continue;
    }
    if (d.type === 'assistant') {
      const content = d.message?.content;
      const tools = Array.isArray(content) ? content.filter((c: any) => c?.type === 'tool_use') : [];
      if (tools.length) {
        const last = tools[tools.length - 1];
        return { state: 'running', tool: { name: String(last.name ?? 'tool'), input: (last.input ?? {}) as Record<string, unknown> }, quietMs };
      }
      if (d.message?.stop_reason === 'end_turn' || settled) return { state: 'idle', tool: null, quietMs };
      return { state: 'running', tool: null, quietMs };
    }
    if (d.type === 'user') {
      if (d.isMeta) continue;
      const text = textOf(d.message?.content);
      if (/<local-command-stdout>|<local-command-stderr>/.test(text)) return { state: 'idle', tool: null, quietMs };
      if (/^\[Request interrupted by user/.test(text.trim())) return { state: 'idle', tool: null, quietMs };
      if (/<command-name>/.test(text) && settled) return { state: 'idle', tool: null, quietMs };
      return { state: 'running', tool: null, quietMs };
    }
    // attachment, mode, permission-mode, last-prompt, file-history-snapshot, summary, …
  }
  return { state: null, tool: null, quietMs };
}

/** claude's permission menu on screen ("Do you want to proceed?" + numbered choices). */
export function screenAsksPermission(screen: string): boolean {
  return /Do you want to (proceed|make this edit|create|allow|run|overwrite|delete|fetch|use)/i.test(screen) && /\b1\.\s*Yes/.test(screen);
}
