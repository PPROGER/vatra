// Remote machines: agents run on a server (its own Vatra instance with tmux, git and
// claude), this Vatra shows and drives them. The connection is an SSH tunnel to the
// remote Vatra, which itself only listens on 127.0.0.1, so nothing is exposed.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import type { MachineInfo, ServerEvent } from './shared/types.js';

export interface MachineConfig {
  id: string;
  name: string;
  /** ssh destination, e.g. "me@build-box" or a Host alias from ~/.ssh/config */
  ssh?: string;
  /** Port of Vatra on the remote machine (default 4317). */
  remotePort?: number;
  /** Direct connection (no ssh) — used by tests. */
  url?: string;
  token?: string;
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new'];

// prints the remote Vatra token from whichever data dir it uses
const TOKEN_SCRIPT = [
  'for f in "${VATRA_HOME:-/nonexistent}/token" "$HOME/.vatra/token" "${XDG_DATA_HOME:-$HOME/.local/share}/vatra/token" "$HOME/.localdelta/token" "${XDG_DATA_HOME:-$HOME/.local/share}/localdelta/token"; do',
  '  if [ -f "$f" ]; then cat "$f"; exit 0; fi;',
  'done; exit 3',
].join(' ');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

class Machine {
  state: MachineInfo['state'] = 'connecting';
  error: string | null = null;
  version: string | null = null;
  private port: number | null = null;
  private hostHeader = '';
  private token: string | null = null;
  private tunnel: ChildProcess | null = null;
  private events: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoff = 3000;
  private stopped = false;

  constructor(
    readonly cfg: MachineConfig,
    private readonly sshBin: string,
    private readonly onEvent: (m: Machine, e: ServerEvent) => void,
    private readonly onChange: (m: Machine) => void,
  ) {}

  info(): MachineInfo {
    return { id: this.cfg.id, name: this.cfg.name, ssh: this.cfg.ssh ?? null, state: this.state, error: this.error, version: this.version };
  }

  get ready() {
    return this.state === 'online' && this.port !== null && this.token !== null;
  }

  private set(state: MachineInfo['state'], error: string | null = null) {
    if (state === this.state && error === this.error) return;
    this.state = state;
    this.error = error;
    this.onChange(this);
  }

  async start() {
    this.stopped = false;
    try {
      if (this.cfg.url) {
        const u = new URL(this.cfg.url);
        this.port = Number(u.port || 80);
        this.hostHeader = u.host;
        this.token = this.cfg.token ?? null;
      } else {
        await this.openTunnel();
      }
      await this.check();
    } catch (e) {
      this.set('offline', (e as Error).message);
      this.retry();
      return;
    }
    this.timer = setInterval(() => void this.check().catch(() => {}), 15_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.events?.close();
    this.events = null;
    this.tunnel?.kill();
    this.tunnel = null;
  }

  private retry() {
    if (this.stopped) return;
    this.stop();
    this.stopped = false;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    setTimeout(() => !this.stopped && void this.start(), wait);
  }

  private ssh(command: string, timeout = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.sshBin, [...SSH_OPTS, this.cfg.ssh!, command], { timeout }, (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const code = (err as { code?: unknown }).code;
        if (code === 3) return reject(new Error('Vatra is not installed on the remote machine (no token found)'));
        reject(new Error(String(stderr).trim().split('\n').pop() || err.message));
      });
    });
  }

  private async openTunnel() {
    if (!this.cfg.ssh) throw new Error('no ssh destination');
    const remotePort = this.cfg.remotePort ?? 4317;
    // single quotes work in sh, bash, zsh and fish login shells alike
    const token = (await this.ssh(`sh -c '${TOKEN_SCRIPT}'`)).trim();
    if (token.length < 32) throw new Error('Vatra is not installed on the remote machine (no token found)');
    this.token = token;
    this.port = await freePort();
    this.hostHeader = `127.0.0.1:${remotePort}`;
    const proc = spawn(this.sshBin, [...SSH_OPTS, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${this.port}:127.0.0.1:${remotePort}`, this.cfg.ssh], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    proc.on('exit', () => {
      if (this.tunnel !== proc || this.stopped) return;
      this.tunnel = null;
      this.set('offline', stderr.trim().split('\n').pop() || 'ssh tunnel closed');
      this.retry();
    });
    this.tunnel = proc;
    // wait until the forwarded port answers
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (proc.exitCode !== null) throw new Error(stderr.trim().split('\n').pop() || 'ssh exited');
      try {
        await this.call('GET', '/api/info');
        return;
      } catch {
        /* not yet */
      }
    }
    throw new Error('the remote Vatra does not answer through the tunnel — is it running there? (vatra start / vatra install-service)');
  }

  private async check() {
    try {
      const info = JSON.parse(await this.call('GET', '/api/info')) as { version?: string };
      this.version = info.version ?? null;
      this.backoff = 3000;
      this.set('online');
      this.listen();
    } catch (e) {
      this.set('offline', (e as Error).message);
      if (!this.cfg.url) this.retry();
    }
  }

  /** Forwards the remote's notifications (agent waits / asks) to our UI. */
  private listen() {
    if (this.events || !this.ready) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws/events?token=${this.token}`, { headers: { host: this.hostHeader } });
    this.events = ws;
    ws.on('message', (raw) => {
      try {
        const e = JSON.parse(String(raw)) as ServerEvent;
        this.onEvent(this, e);
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      if (this.events === ws) this.events = null;
    });
    ws.on('error', () => ws.close());
  }

  private call(method: string, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: this.port!, path, method, headers: { host: this.hostHeader, 'x-vatra-token': this.token ?? '' }, timeout: 8000 },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => (res.statusCode && res.statusCode < 400 ? resolve(body) : reject(new Error(`remote Vatra: HTTP ${res.statusCode} ${body.slice(0, 200)}`))));
        },
      );
      req.on('timeout', () => req.destroy(new Error('remote Vatra: timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  /** Proxies one HTTP request to the remote Vatra. */
  forward(method: string, path: string, headers: IncomingHttpHeaders, body: Buffer | undefined): Promise<IncomingMessage> {
    if (!this.ready) return Promise.reject(new Error(`${this.cfg.name}: ${this.error ?? this.state}`));
    return new Promise((resolve, reject) => {
      const h: Record<string, string> = { host: this.hostHeader, 'x-vatra-token': this.token! };
      for (const k of ['content-type', 'x-filename', 'accept']) if (typeof headers[k] === 'string') h[k] = headers[k] as string;
      if (body) h['content-length'] = String(body.length);
      const req = request({ host: '127.0.0.1', port: this.port!, path, method, headers: h, timeout: 120_000 }, resolve);
      req.on('timeout', () => req.destroy(new Error('remote Vatra: timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** WebSocket to the remote Vatra (terminal, events). */
  connectWs(path: string): WebSocket {
    if (!this.ready) throw new Error(`${this.cfg.name}: ${this.error ?? this.state}`);
    const sep = path.includes('?') ? '&' : '?';
    return new WebSocket(`ws://127.0.0.1:${this.port}${path}${sep}token=${this.token}`, { headers: { host: this.hostHeader } });
  }
}

export class Machines {
  private list = new Map<string, Machine>();

  constructor(
    private readonly emit: (e: ServerEvent) => void,
    private readonly save: (cfgs: MachineConfig[]) => void,
    private readonly sshBin = process.env.VATRA_SSH || 'ssh',
  ) {}

  load(cfgs: MachineConfig[]) {
    for (const c of cfgs) this.add(c, false);
  }

  get(id: string): Machine | undefined {
    return this.list.get(id);
  }

  infos(): MachineInfo[] {
    return [...this.list.values()].map((m) => m.info());
  }

  add(cfg: MachineConfig, persist = true): MachineInfo {
    const m = new Machine(
      cfg,
      this.sshBin,
      (machine, e) => {
        // only what needs your attention; the UI fetches the rest when you open that machine
        if (e.type === 'notify') this.emit({ ...e, title: `${machine.cfg.name} · ${e.title}`, machine: machine.cfg.id });
      },
      (machine) => this.emit({ type: 'machine', machine: machine.info() }),
    );
    this.list.set(cfg.id, m);
    void m.start();
    if (persist) this.persist();
    return m.info();
  }

  remove(id: string) {
    const m = this.list.get(id);
    if (!m) return;
    m.stop();
    this.list.delete(id);
    this.persist();
    this.emit({ type: 'machine_removed', id });
  }

  closeAll() {
    for (const m of this.list.values()) m.stop();
  }

  private persist() {
    this.save([...this.list.values()].map((m) => m.cfg).filter((c) => !c.url));
  }
}
