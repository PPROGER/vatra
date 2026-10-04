// `vatra selftest`: drives a real claude through the running Vatra server and checks
// the parts that can't be tested with a fake CLI — folder trust, hooks, transcript,
// permission prompts, multi-line messages, slash commands.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrusted, setTrust } from './claudetrust.js';
import { getPaths, loadConfig } from './config.js';
import { tr } from './shared/i18n/index.js';

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

  console.log(tr('Vatra selftest — справжній claude, кілька запитів до твоєї підписки.') + '\n');
  let info: { version: string; claudeBin: string | null; tmuxSocket?: string } = { version: '', claudeBin: null };
  try {
    info = await api('GET', '/api/info');
    report('ok', tr('сервер {version} на {url}, claude: {claude}', { version: info.version, url: base, claude: info.claudeBin ?? '—' }));
    if (!info.claudeBin) {
      report('fail', tr('claude не знайдено — встанови Claude Code і зроби /login'));
      return 1;
    }
  } catch (err) {
    report('fail', tr('сервер не відповідає ({error}). Запусти: vatra start', { error: (err as Error).message }));
    return 1;
  }

  /** Collects everything needed to tell why hooks don't reach the server (printed in English for bug reports). */
  const diagnose = async (taskId: number, wt: string) => {
    const line = (k: string, v: string) => console.log(`      · ${k}: ${v}`);
    console.log('    diagnostics:');
    try {
      line('claude', execFileSync(info.claudeBin ?? 'claude', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').find((l) => /\d+\.\d+/.test(l))?.trim() ?? '?');
    } catch (e) {
      line('claude', `error ${(e as Error).message.split('\n')[0]}`);
    }
    const nested = ['IS_DEMO', 'CLAUDECODE'].filter((k) => process.env[k]);
    if (nested.length) line('env of this shell', `${nested.join(', ')} set — Vatra was probably started from inside Claude Code (the launcher unsets them for agents)`);
    line('worktree trusted in ~/.claude.json', isTrusted(wt) ? 'yes' : 'NO — claude skips every hook in untrusted folders (accept the trust dialog, or run claude once in the repository and trust it)');
    const settingsFile = join(wt, '.claude', 'settings.local.json');
    let stopCmd: string | null = null;
    if (!existsSync(settingsFile)) line('hooks file', `MISSING ${settingsFile}`);
    else {
      try {
        const st = JSON.parse(readFileSync(settingsFile, 'utf8'));
        line('hooks file', `${settingsFile} — events: ${Object.keys(st.hooks ?? {}).join(', ') || 'none'}`);
        stopCmd = st.hooks?.Stop?.at(-1)?.hooks?.[0]?.command ?? null;
        const other = Object.keys(st).filter((k) => k !== 'hooks');
        if (other.length) line('other keys in settings.local.json', other.join(', '));
      } catch (e) {
        line('hooks file', `INVALID JSON: ${(e as Error).message}`);
      }
    }
    const managed = ['/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json'];
    for (const f of [...managed, join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.local.json'), join(wt, '.claude', 'settings.json')]) {
      if (!existsSync(f)) continue;
      try {
        const st = JSON.parse(readFileSync(f, 'utf8'));
        const flags = ['disableAllHooks', 'allowManagedHooksOnly'].filter((k) => k in st).map((k) => `${k}=${JSON.stringify(st[k])}`);
        line(f, `hook events: ${Object.keys(st.hooks ?? {}).join(', ') || 'none'}${flags.length ? '; ' + flags.join(', ') : ''}; permissions.defaultMode=${st.permissions?.defaultMode ?? '-'}; keys: ${Object.keys(st).join(', ')}`);
      } catch {
        line(f, 'unreadable');
      }
    }
    const before = (await api('GET', `/api/tasks/${taskId}`)).hooks;
    line('hook calls received by the server', `${before?.count ?? '?'} (rejected: ${before?.rejected ?? '?'}, last: ${before?.last ?? '-'})`);
    const trace = { ran: join(paths.runDir, `hooks-${taskId}.ran`), log: join(paths.runDir, `hooks-${taskId}.log`), flag: join(paths.runDir, `hooks-${taskId}.json`) };
    line('claude ran a Vatra hook at least once', existsSync(trace.ran) ? 'yes (so the curl call fails — see the log below)' : 'NO — claude does not run these hooks at all');
    line('--settings hooks file', existsSync(trace.flag) ? trace.flag : 'missing (server not rebuilt?)');
    if (existsSync(trace.log)) {
      console.log('      · failed hook calls (from the agent environment):');
      for (const l of readFileSync(trace.log, 'utf8').trim().split('\n').slice(-8)) console.log(`          ${l}`);
    }
    const url = stopCmd?.match(/'(http:\/\/127\.0\.0\.1[^']+)'/)?.[1];
    if (url) {
      try {
        const out = execFileSync('curl', ['--noproxy', '*', '-s', '-m', '3', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '{}', '-w', ' HTTP %{http_code}', url.replace('event=Stop', 'event=Probe')], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        line('manual hook call', out.trim() || '(no output)');
      } catch (e) {
        line('manual hook call', `failed: ${(e as Error).message.split('\n')[0]}`);
      }
      await sleep(500);
      const after = (await api('GET', `/api/tasks/${taskId}`)).hooks;
      line('server saw the manual call', after?.count > (before?.count ?? 0) ? 'yes' : 'NO');
    }
    try {
      const sock = info.tmuxSocket ?? cfg.tmuxSocket;
      const cur = execFileSync('tmux', ['-L', sock, 'display-message', '-p', '-t', `=vatra-${taskId}:`, '#{pane_current_command} dead=#{pane_dead}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      line('tmux pane', cur);
      const screen = execFileSync('tmux', ['-L', sock, 'capture-pane', '-p', '-t', `=vatra-${taskId}:`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(-18);
      console.log('      · claude screen (last lines):');
      for (const l of screen) console.log(`          ${l.slice(0, 140)}`);
    } catch (e) {
      line('tmux', `error ${(e as Error).message.split('\n')[0]}`);
    }
    try {
      const real = realpathSync(wt);
      const projDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', real.replace(/[^A-Za-z0-9]/g, '-'));
      const files = existsSync(projDir) ? readdirSync(projDir).filter((f) => f.endsWith('.jsonl')) : [];
      line('claude transcript dir', `${projDir} — ${existsSync(projDir) ? `${files.length} transcript(s)` : 'MISSING'}`);
    } catch (e) {
      line('transcript', `error ${(e as Error).message}`);
    }
  };

  const dir = mkdtempSync(join(tmpdir(), 'vatra-selftest-'));
  const repo = join(dir, 'repo');
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Vatra selftest', '-c', 'user.email=selftest@vatra', ...args], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# vatra selftest\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  // our own throwaway repo: trust it like you'd trust a repo of yours (Vatra passes that on to the worktree)
  let trustedRepo = false;
  try {
    trustedRepo = setTrust(repo, true);
  } catch {
    /* no ~/.claude.json yet */
  }

  let projectId: number | null = null;
  let taskId: number | null = null;
  let wtPath: string | null = null;
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
    wtPath = wt;

    const started = await waitFor(60_000, async () => {
      const t = (await api('GET', `/api/tasks/${task.id}`)).task;
      return t.status !== 'creating' && t.status !== 'queued' ? t : null;
    });
    if (!started) throw new Error(tr('агент не стартував за 60 с'));
    if (started.status === 'error') throw new Error(tr('помилка старту: {reason}', { reason: started.statusReason }));
    report('ok', tr('worktree створено, claude запущено в tmux'));

    // 1. folder trust → card in chat → accept
    const first = await waitFor(45_000, async () => {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      if (c.permission?.kind === 'trust') return 'trust';
      if (c.sessionId) return 'session';
      return null;
    });
    if (first === 'trust') {
      report('ok', tr('питання «довіряти папці?» розпізнано — картка в чаті зʼявилась'));
      await api('POST', `/api/tasks/${task.id}/keys`, { key: 'allow' });
    } else if (first === 'session') {
      report('warn', tr('claude не питав про довіру до папки (мабуть, вона вже довірена) — картку не перевірено'));
    } else {
      report('fail', tr('ні картки довіри, ні хуків за 45 с — глянь вкладку «Термінал», claude може чекати на щось'));
    }

    // 2. transcript (via hooks, or the fallback that reads it directly)
    const session = await waitFor(60_000, async () => (await api('GET', `/api/tasks/${task.id}/chat`)).sessionId);
    if (!session) {
      report('fail', tr('транскрипт claude не знайдено за 60 с — чат не працюватиме'));
      await diagnose(task.id, wt);
      throw new Error('stopping here: the remaining checks need the transcript');
    }
    const hooksWork = await waitFor(20_000, async () => {
      const w = (await api('GET', `/api/tasks/${task.id}`)).hooks?.working;
      return w === null || w === undefined ? null : { w };
    });
    if (hooksWork?.w) report('ok', tr('хуки Claude Code працюють, транскрипт знайдено'));
    else {
      report('warn', tr('claude не запускає хуки Ватри — працюю з його транскриптом напряму (статус може оновлюватись із затримкою в кілька секунд)'));
      await diagnose(task.id, wt);
    }

    // 3. permission prompt for Bash → allow from the chat
    const hello = join(wt, 'hello.txt');
    const perm = await waitFor(150_000, async () => {
      if (existsSync(hello)) return 'done';
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      return c.permission?.kind !== 'trust' && c.permission ? 'perm' : null;
    });
    if (perm === 'perm') {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      report('ok', tr('запит дозволу зʼявився в чаті: {what}', { what: c.permission.tool ?? c.permission.message }));
      await api('POST', `/api/tasks/${task.id}/keys`, { key: 'allow' });
      const ran = await waitFor(60_000, async () => existsSync(hello));
      if (ran) report('ok', tr('кнопка «Дозволити» спрацювала — команда виконалась'));
      else report('fail', tr('після «Дозволити» команда не виконалась — порядок пунктів у меню дозволу інший, скажи про це'));
    } else if (perm === 'done') {
      let mode = '';
      try {
        mode = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).permissions?.defaultMode ?? '';
      } catch {
        /* no user settings */
      }
      if (mode && mode !== 'default') report('warn', tr('дозвіл не знадобився — у твоїх налаштуваннях claude режим дозволів «{mode}» — картку дозволу не перевірено', { mode }));
      else report('warn', tr('дозвіл не знадобився (Bash уже дозволено у твоїх налаштуваннях) — картку дозволу не перевірено'));
    } else {
      report('fail', tr('ні запиту дозволу, ні результату за 150 с'));
    }
    if (existsSync(hello) && readFileSync(hello, 'utf8').includes('vatra-ok')) report('ok', tr('агент виконав команду в своєму worktree'));

    // 4. turn ends → idle, reply visible, context counted
    const idle = await waitFor(120_000, async () => {
      const t = (await api('GET', `/api/tasks/${task.id}`)).task;
      return t.status === 'idle' ? t : null;
    });
    if (idle) report('ok', tr('хід завершився — статус «чекає»'));
    else report('fail', tr('агент не перейшов у «чекає» за 120 с'));
    const chat = await api('GET', `/api/tasks/${task.id}/chat`);
    if (chat.items.some((i: { kind: string }) => i.kind === 'assistant')) report('ok', tr('відповідь агента видно в чаті'));
    else report('fail', tr('у чаті немає відповіді агента — парсер транскрипту не впізнав формат'));
    if (chat.context?.usedTokens > 0) report('ok', tr('контекст: {model}, {tokens} токенів', { model: chat.context.model, tokens: chat.context.usedTokens }));
    else report('warn', tr('немає даних про використання контексту'));

    // 5. multi-line message arrives as ONE message
    const before = chat.items.filter((i: { kind: string }) => i.kind === 'user').length;
    await api('POST', `/api/tasks/${task.id}/message`, { text: 'Line one of a test message.\nLine two of the same message.\nReply with one word: ok' });
    const ml = await waitFor(90_000, async () => {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      const users = c.items.filter((i: { kind: string }) => i.kind === 'user').slice(before);
      return users.length ? users : null;
    });
    if (!ml) report('fail', tr('багаторядкове повідомлення не дійшло'));
    else if (ml.some((u: { text: string }) => u.text.includes('Line one') && u.text.includes('Line two'))) report('ok', tr('багаторядкове повідомлення дійшло одним повідомленням'));
    else report('fail', tr('багаторядкове повідомлення розбилось на кілька — скажи про це'));
    await waitFor(90_000, async () => (await api('GET', `/api/tasks/${task.id}`)).task.status === 'idle');

    // 6. slash command typed into the TUI
    await api('POST', `/api/tasks/${task.id}/message`, { text: '/cost' });
    const slash = await waitFor(30_000, async () => {
      const c = await api('GET', `/api/tasks/${task.id}/chat`);
      return c.items.some((i: { kind: string; command?: string }) => i.kind === 'user' && i.command === '/cost');
    });
    if (slash) report('ok', tr('slash-команда /cost виконалась і видна в чаті'));
    else report('warn', tr('/cost не зʼявився в чаті (команда могла виконатись, але без запису в транскрипт)'));
  } catch (err) {
    report('fail', (err as Error).message);
  } finally {
    const failed = results.some((r) => r.mark === 'fail');
    if (failed && !opts.keep) console.log(`\n  (kept for inspection — discard the "selftest" task in Vatra when done; repo: ${repo})`);
    if (!opts.keep && !failed) {
      if (taskId) await api('POST', `/api/tasks/${taskId}/discard`).catch(() => {});
      if (projectId) await api('DELETE', `/api/projects/${projectId}`).catch(() => {});
      try {
        if (trustedRepo) setTrust(repo, false);
        if (wtPath) setTrust(wtPath, false);
      } catch {
        /* best effort */
      }
      rmSync(dir, { recursive: true, force: true });
    } else if (opts.keep) {
      console.log(`\n  ${tr('(--keep) задачу й проєкт лишено: {repo}', { repo })}`);
    }
  }

  const fails = results.filter((r) => r.mark === 'fail').length;
  const warns = results.filter((r) => r.mark === 'warn').length;
  console.log(
    `\n${fails ? '\x1b[31m' : '\x1b[32m'}${fails ? tr('{n} проблем(и)', { n: fails }) : tr('Усе працює')}\x1b[0m${warns ? tr(', {n} попередж.', { n: warns }) : ''}. ${tr('Скопіюй цей вивід, якщо треба щось поправити.')}`,
  );
  return fails ? 1 : 0;
}
