// End-to-end: real server, real git, real tmux, fake `claude` (test/fake-claude.py).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const root = resolve(__dirname, '..');
const PORT = 4300 + Math.floor(Math.random() * 90);
const SOCKET = `ld-e2e-${process.pid}`;
let home: string;
let repo: string;
let server: ChildProcess | null = null;
let token = '';
let serverLog = '';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  server = spawn(process.execPath, ['--import', 'tsx', join(root, 'server/cli.ts'), 'start'], {
    cwd: root,
    env: {
      ...process.env,
      VATRA_HOME: home,
      VATRA_PORT: String(PORT),
      VATRA_TMUX_SOCKET: SOCKET,
      VATRA_CLAUDE_BIN: join(root, 'test/fake-claude.py'),
      VATRA_NO_NOTIFY: '1',
      VATRA_GH: join(root, 'test/fake-gh.py'),
      FAKE_GH_STATE: join(home, 'gh-state'),
      ANTHROPIC_API_KEY: 'must-not-leak',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => (serverLog += d));
  server.stderr!.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if (serverLog.includes('Vatra')) break;
  }
  token = readFileSync(join(home, 'token'), 'utf8').trim();
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((r) => {
    s.on('exit', () => r());
    s.kill('SIGTERM');
  });
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'x-vatra-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error}`);
  return json as T;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, label: string, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timeout: ${label} ${last ?? ''}\n--- server log ---\n${serverLog}`);
}

const taskStatus = async (id: number) => (await api('GET', `/api/tasks/${id}`)).task;
const waitStatus = (id: number, status: string) =>
  waitFor(async () => {
    const t = await taskStatus(id);
    return t.status === status ? t : undefined;
  }, `task ${id} → ${status}`);

function openPty(id: number): Promise<{ ws: WebSocket; out: () => string }> {
  return new Promise((res, rej) => {
    let buf = '';
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pty/${id}?token=${token}`);
    ws.on('message', (d) => (buf += d.toString()));
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'r', c: 120, r: 30 }));
      res({ ws, out: () => buf });
    });
    ws.on('error', rej);
  });
}

const tmuxHas = (name: string) => {
  try {
    execFileSync('tmux', ['-L', SOCKET, 'has-session', '-t', `=${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  chmodSync(join(root, 'test/fake-claude.py'), 0o755);
  home = mkdtempSync(join(tmpdir(), 'ld-e2e-'));
  repo = join(home, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  await startServer();
}, 30000);

afterAll(async () => {
  await stopServer();
  try {
    execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* none */
  }
  rmSync(home, { recursive: true, force: true });
});

describe('e2e', () => {
  let projectId: number;

  it('rejects requests without token and from foreign hosts', async () => {
    const r1 = await fetch(`http://127.0.0.1:${PORT}/api/projects`);
    expect(r1.status).toBe(401);
    // fetch() can't override Host, use node:http
    const status = await new Promise<number>((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/projects', headers: { 'x-vatra-token': token, host: 'evil.com' } }, (r) => {
        r.resume();
        res(r.statusCode ?? 0);
      });
      req.on('error', rej);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('adds a project', async () => {
    const p = await api('POST', '/api/projects', { repo_path: repo, setup_script: 'echo setup-ran > setup.txt', env_files: ['.env'] });
    expect(p.defaultBranch).toBe('main');
    expect(p.mergeMode).toBe('pr');
    // most tests below exercise the local merge path
    await api('PATCH', `/api/projects/${p.id}`, { merge_mode: 'merge' });
    projectId = p.id;
  });

  it('full cycle: create → agent works → ws terminal → diff → restart/resume → merge', async () => {
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'Додати привітання', prompt: 'hello' });
    expect(t.status).toBe('creating');
    expect(t.branch).toBe('agent/dodaty-pryvitannia');
    await waitStatus(t.id, 'idle');
    const wt = t.worktreePath;
    await waitFor(async () => existsSync(join(wt, 'agent.txt')) && readFileSync(join(wt, 'agent.txt'), 'utf8').includes('hello'), 'agent.txt');
    expect(readFileSync(join(wt, 'setup.txt'), 'utf8').trim()).toBe('setup-ran');
    expect(readFileSync(join(wt, '.env'), 'utf8')).toContain('SECRET');

    // terminal over websocket: backlog + input
    const { ws, out } = await openPty(t.id);
    await waitFor(async () => out().includes('API_KEY=unset') && out().includes('PORT=5100'), 'backlog');
    ws.send(JSON.stringify({ t: 'i', d: 'second\r' }));
    await waitFor(async () => readFileSync(join(wt, 'agent.txt'), 'utf8').includes('second'), 'typed input reaches agent');
    await waitStatus(t.id, 'idle');

    // diff: agent changes visible, our hook settings and env files are not
    const diff = await api('GET', `/api/tasks/${t.id}/diff?mode=all`);
    expect(diff.patch).toContain('+second');
    expect(diff.untracked).toContain('agent.txt');
    expect(diff.patch).not.toContain('settings.local.json');
    expect(diff.patch).not.toContain('SECRET');

    // restart → resumes the same claude session id
    const before = (await api('GET', `/api/tasks/${t.id}`)).sessions[0].claudeSessionId;
    expect(before).toBeTruthy();
    ws.close();
    await api('POST', `/api/tasks/${t.id}/restart`);
    await waitStatus(t.id, 'idle');
    const sessions = (await api('GET', `/api/tasks/${t.id}`)).sessions;
    expect(sessions.length).toBe(2);
    expect(sessions[1].endedAt).toBeTruthy();
    await waitFor(async () => (await api('GET', `/api/tasks/${t.id}`)).sessions[0].claudeSessionId === before, 'resumed session id');
    const pty2 = await openPty(t.id);
    await waitFor(async () => pty2.out().includes('MODE=RESUMED'), 'resume flag');
    pty2.ws.close();

    // merge (squash) — uncommitted work gets committed first
    const m = await api('POST', `/api/tasks/${t.id}/merge`, { strategy: 'squash' });
    expect(m.task.status).toBe('merged');
    expect(readFileSync(join(repo, 'agent.txt'), 'utf8')).toContain('second');
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('Додати привітання');
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'agent/*')).toBe('');
    expect(tmuxHas(`vatra-${t.id}`)).toBe(false);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
  }, 60000);

  it('discard removes worktree, branch and session', async () => {
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'throwaway', prompt: 'x' });
    await waitStatus(t.id, 'idle');
    const d = await api('POST', `/api/tasks/${t.id}/discard`);
    expect(d.status).toBe('discarded');
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'agent/throwaway')).toBe('');
    expect(tmuxHas(`vatra-${t.id}`)).toBe(false);
  }, 30000);

  it('chat: transcript, messages, slash commands, permissions, uploads, @files', async () => {
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'chat', prompt: 'перший' });
    await waitStatus(t.id, 'idle');
    // transcript → chat items
    const chat = await waitFor(async () => {
      const c = await api('GET', `/api/tasks/${t.id}/chat`);
      return c.items.some((i: any) => i.kind === 'tool' && i.done) ? c : undefined;
    }, 'chat items');
    expect(chat.items.find((i: any) => i.kind === 'user').text).toBe('перший');
    expect(chat.items.some((i: any) => i.kind === 'assistant' && i.text.includes('Готово'))).toBe(true);
    expect(chat.context.usedTokens).toBeGreaterThan(10000);
    expect(chat.context.windowTokens).toBe(1_000_000);

    // live events over /ws/events
    const events: any[] = [];
    const ews = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events?token=${token}`);
    ews.on('message', (d) => events.push(JSON.parse(d.toString())));
    await new Promise((r) => ews.on('open', r));

    // message with an attachment
    const up = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${t.id}/uploads`, {
      method: 'POST',
      headers: { 'x-vatra-token': token, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('схема.png') },
      body: Buffer.from('PNGDATA'),
    }).then((r) => r.json());
    expect(up.path).toContain('схема.png');
    const sent = await api('POST', `/api/tasks/${t.id}/message`, { text: 'другий', attachments: [up.path, '/etc/passwd'] });
    expect(sent.delivered).toBe('typed');
    await waitFor(async () => readFileSync(join(t.worktreePath, 'agent.txt'), 'utf8').includes('другий'), 'message typed');
    await waitFor(async () => events.some((e) => e.type === 'chat' && e.taskId === t.id && e.items.some((i: any) => i.kind === 'assistant')), 'chat event');
    await waitStatus(t.id, 'idle');
    const preview = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${t.id}/uploads/file?path=${encodeURIComponent(up.path)}&token=${token}`);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`http://127.0.0.1:${PORT}/api/tasks/${t.id}/uploads/file?path=/etc/passwd&token=${token}`)).status).toBe(404);

    // slash command goes through the TUI and shows up as a command + output
    await api('POST', `/api/tasks/${t.id}/message`, { text: '/compact focus on tests' });
    await waitFor(async () => {
      const c = await api('GET', `/api/tasks/${t.id}/chat`);
      return c.items.some((i: any) => i.kind === 'user' && i.command === '/compact' && i.text === '/compact focus on tests') && c.items.some((i: any) => i.kind === 'system' && i.text === 'ran /compact');
    }, 'slash command in chat');

    // permission prompt → chat meta → allow via keys
    await api('POST', `/api/tasks/${t.id}/message`, { text: 'ask-permission please' });
    await waitFor(async () => (await api('GET', `/api/tasks/${t.id}/chat`)).permission?.tool?.startsWith('Write:'), 'permission meta');
    await api('POST', `/api/tasks/${t.id}/keys`, { key: 'allow' });
    await waitFor(async () => readFileSync(join(t.worktreePath, 'agent.txt'), 'utf8').includes('ask-permission'), 'approved tool ran');
    expect((await api('GET', `/api/tasks/${t.id}/chat`)).permission).toBeNull();

    // @-mentions and commands
    const files = await api('GET', `/api/tasks/${t.id}/files?q=read`);
    expect(files).toContain('README.md');
    const cmds = await api('GET', `/api/tasks/${t.id}/commands`);
    expect(cmds.find((c: any) => c.name === '/compact')).toBeTruthy();
    expect(cmds.find((c: any) => c.name === '/model').interactive).toBe(true);

    ews.close();
    await api('POST', `/api/tasks/${t.id}/discard`);
  }, 60000);

  it('new task from a chat message: title from prompt, draft attachments, trust prompt, rename', async () => {
    const up = await fetch(`http://127.0.0.1:${PORT}/api/projects/${projectId}/uploads`, {
      method: 'POST',
      headers: { 'x-vatra-token': token, 'content-type': 'application/octet-stream', 'x-filename': 'spec.txt' },
      body: Buffer.from('spec'),
    }).then((r) => r.json());
    expect(up.path).toContain('/drafts/');
    const files = await api('GET', `/api/projects/${projectId}/files?q=readme`);
    expect(files).toContain('README.md');
    const t = await api('POST', `/api/projects/${projectId}/tasks`, {
      prompt: '## Зроби trust-me перевірку\nдругий рядок',
      attachments: [up.path, '/etc/passwd'],
    });
    expect(t.title).toBe('Зроби trust-me перевірку');
    expect(t.prompt).toContain('прикріплені файли');
    expect(t.prompt).toContain(`/uploads/task-${t.id}/`);
    expect(t.prompt).not.toContain('passwd');
    expect(existsSync(up.path)).toBe(false);

    // claude asks to trust the new folder → card in chat → accept from the chat
    await waitFor(async () => (await api('GET', `/api/tasks/${t.id}/chat`)).permission?.kind === 'trust', 'trust card');
    await api('POST', `/api/tasks/${t.id}/keys`, { key: 'allow' });
    await waitStatus(t.id, 'idle');
    expect(readFileSync(join(t.worktreePath, 'agent.txt'), 'utf8')).toContain('trust-me');

    const renamed = await api('PATCH', `/api/tasks/${t.id}`, { title: 'Нова назва' });
    expect(renamed.title).toBe('Нова назва');
    expect(renamed.branch).toBe(t.branch);
    await api('POST', `/api/tasks/${t.id}/discard`);
  }, 60000);

  it('follows a branch the agent renamed, merges it and cleans up', async () => {
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'rename me', prompt: 'renamed-branch-work' });
    await waitStatus(t.id, 'idle');
    sh(t.worktreePath, 'add', '-A');
    sh(t.worktreePath, 'commit', '-qm', 'agent work');
    sh(t.worktreePath, 'branch', '-m', 'feat/agent-picked-name');
    const diff = await api('GET', `/api/tasks/${t.id}/diff?mode=committed`);
    expect(diff.patch).toContain('renamed-branch-work');
    expect((await taskStatus(t.id)).branch).toBe('feat/agent-picked-name');
    const m = await api('POST', `/api/tasks/${t.id}/merge`, { strategy: 'merge' });
    expect(m.task.status).toBe('merged');
    expect(sh(repo, 'log', '-1', '--format=%s')).toContain('feat/agent-picked-name');
    expect(sh(repo, 'branch', '--list', 'feat/agent-picked-name')).toBe('');
  }, 30000);

  it('never deletes a pre-existing branch the agent switched to', async () => {
    sh(repo, 'branch', 'user/keep-me');
    await sleep(1100); // reflog timestamps have 1s resolution
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'switcher', prompt: 'x' });
    await waitStatus(t.id, 'idle');
    sh(t.worktreePath, 'stash', '-u');
    sh(t.worktreePath, 'checkout', '-q', 'user/keep-me');
    await api('POST', `/api/tasks/${t.id}/discard`);
    expect(sh(repo, 'branch', '--list', 'user/keep-me')).toContain('user/keep-me');
  }, 30000);

  it('PR mode: PR is opened/updated, a merged PR closes the task', async () => {
    const origin = join(home, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    sh(repo, 'remote', 'add', 'origin', origin);
    sh(repo, 'push', '-q', 'origin', 'main');
    await api('PATCH', `/api/projects/${projectId}`, { merge_mode: 'pr' });
    try {
      const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'via pr', prompt: 'pr-work' });
      await waitStatus(t.id, 'idle');

      const first = await api('POST', `/api/tasks/${t.id}/pr`);
      expect(first.created).toBe(true);
      expect(first.url).toBe('https://github.com/acme/demo/pull/7');
      expect(first.task.prState).toBe('OPEN');
      expect(execFileSync('git', ['--git-dir', origin, 'branch', '--list', t.branch], { encoding: 'utf8' })).toContain(t.branch);

      // agent keeps working → the same PR gets updated by a push
      await api('POST', `/api/tasks/${t.id}/message`, { text: 'more-work' });
      await waitFor(async () => readFileSync(join(t.worktreePath, 'agent.txt'), 'utf8').includes('more-work'), 'more work');
      await waitStatus(t.id, 'idle');
      const second = await api('POST', `/api/tasks/${t.id}/pr`);
      expect(second.created).toBe(false);
      expect(second.url).toBe(first.url);

      // merged on GitHub → task closes and local leftovers go away
      writeFileSync(join(home, 'gh-state'), 'MERGED');
      const done = await api('POST', `/api/tasks/${t.id}/pr/check`);
      expect(done.status).toBe('merged');
      expect(existsSync(t.worktreePath)).toBe(false);
      expect(sh(repo, 'branch', '--list', t.branch)).toBe('');
      expect(tmuxHas(`vatra-${t.id}`)).toBe(false);
    } finally {
      await api('PATCH', `/api/projects/${projectId}`, { merge_mode: 'merge' });
    }
  }, 60000);

  it('merge & push without touching your checkout (base not checked out)', async () => {
    // origin was added by the PR test
    sh(repo, 'checkout', '-q', '-b', 'user/elsewhere');
    try {
      const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'merge and push', prompt: 'pushed-work' });
      await waitStatus(t.id, 'idle');
      const m = await api('POST', `/api/tasks/${t.id}/merge`, { strategy: 'squash', push: true });
      expect(m.pushed).toBe(true);
      expect(m.task.status).toBe('merged');
      expect(sh(repo, 'branch', '--show-current')).toBe('user/elsewhere');
      expect(sh(repo, 'log', '-1', '--format=%s', 'main')).toBe('merge and push');
      const origin = join(home, 'origin.git');
      expect(execFileSync('git', ['--git-dir', origin, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('merge and push');
      expect(sh(repo, 'worktree', 'list')).not.toContain('merge-');
    } finally {
      sh(repo, 'checkout', '-q', 'main');
    }
  }, 30000);

  it('folder picking helpers', async () => {
    const list = await api('GET', `/api/fs/list?path=${encodeURIComponent(home)}`);
    expect(list.entries.find((e: any) => e.name === 'repo').isGit).toBe(true);
    const info = await api('GET', `/api/fs/inspect?path=${encodeURIComponent(repo)}`);
    expect(info.isGit).toBe(true);
    expect(info.defaultBranch).toBe('main');
    expect(info.envFiles).toContain('.env');
  });

  it('merge conflict aborts, keeps repo clean and asks the agent to rebase', async () => {
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'conflict', prompt: 'agent-line' });
    await waitStatus(t.id, 'idle');
    writeFileSync(join(repo, 'agent.txt'), 'main-line\n');
    sh(repo, 'commit', '-qam', 'main edits agent.txt');
    const m = await api('POST', `/api/tasks/${t.id}/merge`, { strategy: 'merge' });
    expect(m.conflict).toEqual(['agent.txt']);
    expect(m.task.status).toBe('review');
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    await waitFor(async () => readFileSync(join(t.worktreePath, 'agent.txt'), 'utf8').includes('rebase'), 'agent got rebase request');
    await api('POST', `/api/tasks/${t.id}/discard`);
  }, 30000);

  it('agents survive a server restart (tmux)', async () => {
    const t = await api('POST', `/api/projects/${projectId}/tasks`, { title: 'survivor', prompt: 'before' });
    await waitStatus(t.id, 'idle');
    await stopServer();
    expect(tmuxHas(`vatra-${t.id}`)).toBe(true);
    serverLog = '';
    await startServer();
    const after = await waitStatus(t.id, 'idle');
    expect(after.alive).toBe(true);
    const { ws, out } = await openPty(t.id);
    ws.send(JSON.stringify({ t: 'i', d: 'after-restart\r' }));
    await waitFor(async () => readFileSync(join(t.worktreePath, 'agent.txt'), 'utf8').includes('after-restart'), 'input after restart');
    // agent exits → task goes to review
    ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
    await waitStatus(t.id, 'review');
    ws.close();
    await api('POST', `/api/tasks/${t.id}/discard`);
  }, 60000);

  it('respects maxActive with a queue', async () => {
    // default maxActive=4; fill it
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await api('POST', `/api/projects/${projectId}/tasks`, { title: `q${i}`, prompt: 'p' })).id);
    await waitFor(async () => {
      const ts = await Promise.all(ids.map(taskStatus));
      return ts.filter((x) => x.status === 'idle').length === 4 && ts.filter((x) => x.status === 'queued').length === 1;
    }, '4 live + 1 queued');
    await api('POST', `/api/tasks/${ids[0]}/stop`);
    await waitStatus(ids[4], 'idle');
    for (const id of ids) await api('POST', `/api/tasks/${id}/discard`);
  }, 60000);
});
