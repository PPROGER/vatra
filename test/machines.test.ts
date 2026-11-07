// Remote machines: a second Vatra plays the server; the first one reaches it directly
// (url + token) and, when sshd is available, through a real ssh tunnel.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const root = resolve(__dirname, '..');
const base = 4200 + Math.floor(Math.random() * 80);
const LOCAL = base;
const REMOTE = base + 90;
const SSHD = base + 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let dir: string;
const procs: ChildProcess[] = [];
let localToken = '';
let sshReady = false;

function start(home: string, port: number, socket: string, extraEnv: Record<string, string> = {}) {
  const p = spawn(process.execPath, ['--import', 'tsx', join(root, 'server/cli.ts'), 'start'], {
    cwd: root,
    env: {
      ...process.env,
      VATRA_HOME: home,
      VATRA_PORT: String(port),
      VATRA_TMUX_SOCKET: socket,
      VATRA_CLAUDE_BIN: join(root, 'test/fake-claude.py'),
      VATRA_NO_NOTIFY: '1',
      LANG: 'en_US.UTF-8',
      LC_ALL: '',
      CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  p.stdout!.on('data', (d) => (log += d));
  p.stderr!.on('data', (d) => (log += d));
  procs.push(p);
  return () => log;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false | null>, label: string, ms = 20000): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timeout: ${label} ${last ?? ''}`);
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${LOCAL}${path}`, {
    method,
    headers: { 'x-vatra-token': localToken, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.error}`);
  return json as T;
}

beforeAll(async () => {
  chmodSync(join(root, 'test/fake-claude.py'), 0o755);
  dir = mkdtempSync(join(tmpdir(), 'vatra-machines-'));
  const remoteHome = join(dir, 'remote');
  const localHome = join(dir, 'local');
  mkdirSync(remoteHome);
  mkdirSync(localHome);
  start(remoteHome, REMOTE, `vm-r-${process.pid}`);
  await waitFor(async () => existsSync(join(remoteHome, 'token')) && (await fetch(`http://127.0.0.1:${REMOTE}/`).then((r) => r.ok)), 'remote up');
  const remoteToken = readFileSync(join(remoteHome, 'token'), 'utf8').trim();

  // optional: a private sshd so the tunnel path is tested for real
  let sshCfg: object | null = null;
  try {
    const sshDir = join(dir, 'ssh');
    mkdirSync(sshDir, { mode: 0o700 });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(sshDir, 'host')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(sshDir, 'user')]);
    writeFileSync(join(sshDir, 'authorized_keys'), readFileSync(join(sshDir, 'user.pub')), { mode: 0o600 });
    const user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(sshDir, 'sshd_config'),
      [`Port ${SSHD}`, 'ListenAddress 127.0.0.1', `HostKey ${join(sshDir, 'host')}`, `AuthorizedKeysFile ${join(sshDir, 'authorized_keys')}`, 'PasswordAuthentication no', 'StrictModes no', 'UsePAM no', `PidFile ${join(sshDir, 'pid')}`, 'AllowTcpForwarding yes'].join('\n') + '\n',
    );
    try {
      mkdirSync('/run/sshd', { recursive: true }); // privilege separation dir
    } catch {
      /* not root: sshd may still work */
    }
    const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(sshDir, 'sshd_config')], { stdio: 'ignore' });
    procs.push(sshd);
    // ssh wrapper: our port and key; the remote data dir for the token lookup
    const wrapper = join(sshDir, 'ssh-wrapper.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nlast=""; for a in "$@"; do last="$a"; done\ncase "$last" in "sh -c"*) set -- "$@"; n=$#; i=0; for a in "$@"; do i=$((i+1)); if [ $i -lt $n ]; then set -- "$@" "$a"; fi; done; shift $n; exec ssh -p ${SSHD} -i ${join(sshDir, 'user')} -o UserKnownHostsFile=${join(sshDir, 'known')} -o StrictHostKeyChecking=accept-new "$@" "VATRA_HOME=${remoteHome} $last";; esac\nexec ssh -p ${SSHD} -i ${join(sshDir, 'user')} -o UserKnownHostsFile=${join(sshDir, 'known')} -o StrictHostKeyChecking=accept-new "$@"\n`,
      { mode: 0o755 },
    );
    await waitFor(async () => {
      try {
        execFileSync(wrapper, ['-o', 'BatchMode=yes', `${user}@127.0.0.1`, 'true'], { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }, 'sshd up', 8000);
    sshReady = true;
    sshCfg = { wrapper, dest: `${user}@127.0.0.1` };
    process.env.VATRA_TEST_SSH_DEST = `${user}@127.0.0.1`;
    writeFileSync(join(localHome, 'ssh-wrapper-path'), wrapper);
  } catch {
    sshReady = false;
  }

  writeFileSync(
    join(localHome, 'config.json'),
    JSON.stringify({ machines: [{ id: 'box', name: 'box', url: `http://127.0.0.1:${REMOTE}`, token: remoteToken }] }),
  );
  start(localHome, LOCAL, `vm-l-${process.pid}`, sshCfg ? { VATRA_SSH: (sshCfg as { wrapper: string }).wrapper } : {});
  await waitFor(async () => existsSync(join(localHome, 'token')) && (await fetch(`http://127.0.0.1:${LOCAL}/`).then((r) => r.ok)), 'local up');
  localToken = readFileSync(join(localHome, 'token'), 'utf8').trim();
}, 40000);

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await sleep(500);
  for (const s of [`vm-r-${process.pid}`, `vm-l-${process.pid}`]) {
    try {
      execFileSync('tmux', ['-L', s, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* none */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('remote machines', () => {
  it('drives a task on the remote Vatra through /m/<id>/…', async () => {
    const m = await waitFor(async () => (await api('GET', '/api/machines')).find((x: any) => x.id === 'box' && x.state === 'online'), 'machine online');
    expect(m.version).toBeTruthy();

    const repo = join(dir, 'remote-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const project = await api('POST', '/m/box/api/projects', { repo_path: repo });
    expect((await api('GET', '/api/projects')).length).toBe(0); // nothing on this computer
    const task = await api('POST', `/m/box/api/projects/${project.id}/tasks`, { title: 'remote', prompt: 'hello from afar' });
    await waitFor(async () => (await api('GET', `/m/box/api/tasks/${task.id}`)).task.status === 'idle', 'remote task idle');
    expect(readFileSync(join(task.worktreePath, 'agent.txt'), 'utf8')).toContain('hello from afar');
    const chat = await api('GET', `/m/box/api/tasks/${task.id}/chat`);
    expect(chat.items.some((i: any) => i.kind === 'assistant')).toBe(true);

    // websockets: events and the terminal go through the proxy too
    const events: any[] = [];
    const ev = new WebSocket(`ws://127.0.0.1:${LOCAL}/m/box/ws/events?token=${localToken}`);
    ev.on('message', (d) => events.push(JSON.parse(String(d))));
    await new Promise((r) => ev.on('open', r));
    let term = '';
    const pty = new WebSocket(`ws://127.0.0.1:${LOCAL}/m/box/ws/pty/${task.id}?token=${localToken}`);
    pty.on('message', (d) => (term += String(d)));
    await new Promise((r) => pty.on('open', r));
    pty.send(JSON.stringify({ t: 'r', c: 120, r: 30 }));
    await api('POST', `/m/box/api/tasks/${task.id}/message`, { text: 'second' });
    await waitFor(async () => events.some((e) => e.type === 'task' && e.task.id === task.id), 'remote event');
    await waitFor(async () => term.includes('second'), 'remote terminal output');
    ev.close();
    pty.close();

    // the local token is needed for the proxy
    expect((await fetch(`http://127.0.0.1:${LOCAL}/m/box/api/tasks`)).status).toBe(401);
    await api('POST', `/m/box/api/tasks/${task.id}/discard`);
  }, 40000);

  it('connects over a real ssh tunnel (skipped without sshd)', async () => {
    if (!sshReady) return console.warn('sshd not available — ssh tunnel test skipped');
    console.warn('ssh tunnel test: running');
    const dest = process.env.VATRA_TEST_SSH_DEST!;
    await expect(api('POST', '/api/machines', { ssh: '-oProxyCommand=evil' })).rejects.toThrow();
    const added = await api('POST', '/api/machines', { name: 'tunnel', ssh: dest, remotePort: REMOTE });
    const m = await waitFor(async () => (await api('GET', '/api/machines')).find((x: any) => x.id === added.id && x.state === 'online'), 'tunnel online', 30000);
    expect(m.ssh).toBe(dest);
    const info = await api('GET', `/m/${added.id}/api/info`);
    expect(info.version).toBeTruthy();
    await api('DELETE', `/api/machines/${added.id}`);
    expect((await api('GET', '/api/machines')).some((x: any) => x.id === added.id)).toBe(false);
  }, 40000);
});
