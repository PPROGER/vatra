// `vatra selftest`: drives a real claude through the running Vatra server and checks
// the parts that can't be tested with a fake CLI — folder trust, hooks, transcript,
// permission prompts, multi-line messages, slash commands.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, loadConfig } from './config.js';

type Mark = 'ok' | 'warn' | 'fail';
const ICON: Record<Mark, string> = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function selftest(opts: { keep?: boolean } = {}): Promise<number> {
  const paths = getPaths();
  const cfg = loadConfig(paths);
  const base = `http://127.0.0.1:${cfg.port}`;
  let token = '';
  try {
    token = readFileSync(paths.tokenFile, 'utf8').trim();
  } catch {
    /* handled below */
  }
  const results: { mark: Mark; text: string }[] = [];
  const report = (mark: Mark, text: string) => {
    results.push({ mark, text });
    console.log(`  ${ICON[mark]} ${text}`);
  };

  const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-vatra-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${(json as { error?: string }).error ?? res.status}`);
    return json as T;
  };
  const waitFor = async <T>(ms: number, fn: () => Promise<T | undefined | false | null>): Promise<T | null> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* retry */
      }
      await sleep(700);
    }
    return null;
  };

  console.log('Vatra selftest — справжній claude, кілька запитів до твоєї підписки.\n');
  try {
    const info = await api('GET', '/api/info');
    report('ok', `сервер ${info.version} на ${base}, claude: ${info.claudeBin ?? '—'}`);
    if (!info.claudeBin) {
      report('fail', 'claude не знайдено — встанови Claude Code і зроби /login');
      return 1;
    }
  } catch (err) {
    report('fail', `сервер не відповідає (${(err as Error).message}). Запусти: vatra start`);
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), 'vatra-selftest-'));
  const repo = join(dir, 'repo');
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Vatra selftest', '-c', 'user.email=selftest@vatra', ...args], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# vatra selftest\n');
  g('add', '.');
  g('commit', '-qm', 'init');

  let projectId: number | null = null;
  let taskId: number | null = null;
  try {
    const project = await api('POST', '/api/projects', { repo_path: repo, name: 'vatra-selftest', merge_mode: 'merge' });
    projectId = project.id;
    const task = await api('POST', `/api/projects/${project.id}/tasks`, {
      title: 'selftest',
      prompt:
        'This is an automated check of the Vatra dashboard. Be brief. Run exactly this Bash command: ' +
        '`echo vatra-ok > hello.txt` — then reply with the single word "done". Do nothing else.',
    });
    taskId = task.id;
    const wt: string = task.worktreePath;

    const started = await waitFor(60_000, async () => {
      const t = (await api('GET', `/api/tasks/${task.id}`)).task;
      return t.status !== 'creating' && t.status !== 'queued' ? t : null;
    });
    if (!started) throw new Error('агент не стартував за 60 с');
    if (started.status === 'error') throw new Error(`помилка старту: ${started.statusReason}`);
    report('ok', 'worktree створено, claude запущено в tmux');

    // 1. folder trust → card in chat → accept
    const first = await waitFor(45_000, async () => {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      if (c.permission?.kind === 'trust') return 'trust';
      if (c.sessionId) return 'session';
      return null;
    });
    if (first === 'trust') {
      report('ok', 'питання «довіряти папці?» розпізнано — картка в чаті зʼявилась');
      await api('POST', `/api/tasks/${task.id}/keys`, { key: 'allow' });
    } else if (first === 'session') {
      report('warn', 'claude не питав про довіру до папки (мабуть, вона вже довірена) — картку не перевірено');
    } else {
      report('fail', 'ні картки довіри, ні хуків за 45 с — глянь вкладку «Термінал», claude може чекати на щось');
    }

    // 2. hooks + transcript
    const session = await waitFor(60_000, async () => (await api('GET', `/api/tasks/${task.id}/chat`)).sessionId);
    if (session) report('ok', 'хуки Claude Code працюють, транскрипт знайдено');
    else report('fail', 'хуки не прийшли за 60 с (перевір .claude/settings.local.json у worktree)');

    // 3. permission prompt for Bash → allow from the chat
    const hello = join(wt, 'hello.txt');
    const perm = await waitFor(150_000, async () => {
      if (existsSync(hello)) return 'done';
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      return c.permission?.kind !== 'trust' && c.permission ? 'perm' : null;
    });
    if (perm === 'perm') {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      report('ok', `запит дозволу зʼявився в чаті: ${c.permission.tool ?? c.permission.message}`);
      await api('POST', `/api/tasks/${task.id}/keys`, { key: 'allow' });
      const ran = await waitFor(60_000, async () => existsSync(hello));
      if (ran) report('ok', 'кнопка «Дозволити» спрацювала — команда виконалась');
      else report('fail', 'після «Дозволити» команда не виконалась — порядок пунктів у меню дозволу інший, скажи про це');
    } else if (perm === 'done') {
      report('warn', 'дозвіл не знадобився (Bash уже дозволено у твоїх налаштуваннях) — картку дозволу не перевірено');
    } else {
      report('fail', 'ні запиту дозволу, ні результату за 150 с');
    }
    if (existsSync(hello) && readFileSync(hello, 'utf8').includes('vatra-ok')) report('ok', 'агент виконав команду в своєму worktree');

    // 4. turn ends → idle, reply visible, context counted
    const idle = await waitFor(120_000, async () => {
      const t = (await api('GET', `/api/tasks/${task.id}`)).task;
      return t.status === 'idle' ? t : null;
    });
    if (idle) report('ok', 'хід завершився — статус «чекає» (хук Stop)');
    else report('fail', 'агент не перейшов у «чекає» за 120 с');
    const chat = await api('GET', `/api/tasks/${task.id}/chat`);
    if (chat.items.some((i: { kind: string }) => i.kind === 'assistant')) report('ok', 'відповідь агента видно в чаті');
    else report('fail', 'у чаті немає відповіді агента — парсер транскрипту не впізнав формат');
    if (chat.context?.usedTokens > 0) report('ok', `контекст: ${chat.context.model}, ${chat.context.usedTokens} токенів`);
    else report('warn', 'немає даних про використання контексту');

    // 5. multi-line message arrives as ONE message
    const before = chat.items.filter((i: { kind: string }) => i.kind === 'user').length;
    await api('POST', `/api/tasks/${task.id}/message`, { text: 'Line one of a test message.\nLine two of the same message.\nReply with one word: ok' });
    const ml = await waitFor(90_000, async () => {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      const users = c.items.filter((i: { kind: string }) => i.kind === 'user').slice(before);
      return users.length ? users : null;
    });
    if (!ml) report('fail', 'багаторядкове повідомлення не дійшло');
    else if (ml.some((u: { text: string }) => u.text.includes('Line one') && u.text.includes('Line two'))) report('ok', 'багаторядкове повідомлення дійшло одним повідомленням');
    else report('fail', 'багаторядкове повідомлення розбилось на кілька — скажи про це');
    await waitFor(90_000, async () => (await api('GET', `/api/tasks/${task.id}`)).task.status === 'idle');

    // 6. slash command typed into the TUI
    await api('POST', `/api/tasks/${task.id}/message`, { text: '/cost' });
    const slash = await waitFor(30_000, async () => {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      return c.items.some((i: { kind: string; command?: string }) => i.kind === 'user' && i.command === '/cost');
    });
    if (slash) report('ok', 'slash-команда /cost виконалась і видна в чаті');
    else report('warn', '/cost не зʼявився в чаті (команда могла виконатись, але без запису в транскрипт)');
  } catch (err) {
    report('fail', (err as Error).message);
  } finally {
    if (!opts.keep) {
      if (taskId) await api('POST', `/api/tasks/${taskId}/discard`).catch(() => {});
      if (projectId) await api('DELETE', `/api/projects/${projectId}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    } else {
      console.log(`\n  (--keep) задачу й проєкт лишено: ${repo}`);
    }
  }

  const fails = results.filter((r) => r.mark === 'fail').length;
  const warns = results.filter((r) => r.mark === 'warn').length;
  console.log(`\n${fails ? '\x1b[31m' : '\x1b[32m'}${fails ? `${fails} проблем(и)` : 'Усе працює'}\x1b[0m${warns ? `, ${warns} попередж.` : ''}. Скопіюй цей вивід, якщо треба щось поправити.`);
  return fails ? 1 : 0;
}
