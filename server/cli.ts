#!/usr/bin/env node
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ensureDirs, getPaths, loadConfig, loadToken, resolveLanguage, saveConfig, type Config } from './config.js';
import { openDb } from './db.js';
import { isSupportedPlatform, loginShellPath, platform, resolveClaudeBin } from './platform.js';
import { TerminalHub } from './pty.js';
import { TaskService } from './service.js';
import type { ServerEvent, ServerInfo } from './shared/types.js';
import { Tmux } from './tmux.js';
import { ChatHub } from './transcript.js';
import { selftest } from './selftest.js';
import { DiffWatcher } from './watcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = findPkgRoot(here);
const require = createRequire(import.meta.url);

function findPkgRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    d = dirname(d);
  }
  return start;
}

const version = (() => {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
})();

async function start(dev: boolean, openUi = false) {
  if (!isSupportedPlatform()) {
    console.error('Vatra підтримує лише macOS і Linux (Windows — через WSL2).');
    process.exit(1);
  }
  const paths = getPaths();
  ensureDirs(paths);
  const config = loadConfig(paths);
  const token = loadToken(paths);
  const warnings: string[] = [];

  const tmux = new Tmux(config.tmuxSocket, paths.tmuxConf);
  const tmuxVersion = await tmux.version();
  if (!tmuxVersion) {
    console.error('tmux не знайдено. Встанови: brew install tmux  /  sudo apt install tmux');
    process.exit(1);
  }
  tmux.writeConf();
  await tmux.reloadConf().catch(() => {});

  const [claudeBin, pathEnv] = await Promise.all([resolveClaudeBin(config.claudeBin), loginShellPath()]);
  if (!claudeBin) warnings.push('claude CLI не знайдено — задачі не зможуть стартувати. Встанови Claude Code або вкажи claudeBin у config.json.');
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    warnings.push('У середовищі сервера є ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN — для агентів їх буде прибрано, щоб працювала підписка.');
  }

  const { db, sqlite } = openDb(paths.dbFile);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const emit = (e: ServerEvent) => bus.emit('event', e);
  const subscribe = (fn: (e: ServerEvent) => void) => {
    bus.on('event', fn);
    return () => bus.off('event', fn);
  };

  const hub = new TerminalHub(tmux, config.ringBufferBytes);
  const chat = new ChatHub(emit, config.contextWindow);
  let service: TaskService;
  const watcher = new DiffWatcher((id) => service.diffChanged(id));
  service = new TaskService({
    db,
    paths,
    config,
    tmux,
    hub,
    watcher,
    emit,
    claudeBin,
    pathEnv,
    chat,
    log: (m) => console.log(m),
  });

  const info = (): ServerInfo => ({
    version,
    platform,
    dataDir: paths.dataDir,
    maxActive: config.maxActive,
    idleSleepMinutes: config.idleSleepMinutes,
    language: resolveLanguage(config.language),
    languageSetting: config.language,
    claudeBin,
    warnings,
  });

  const webDir = join(pkgRoot, 'dist', 'web');
  const settings = {
    patch: async (p: Partial<Pick<Config, 'language' | 'idleSleepMinutes' | 'maxActive'>>) => {
      const clean: Partial<Config> = {};
      if (p.language && ['auto', 'uk', 'en'].includes(p.language)) clean.language = p.language;
      if (typeof p.idleSleepMinutes === 'number' && p.idleSleepMinutes >= 0 && p.idleSleepMinutes <= 24 * 60) clean.idleSleepMinutes = p.idleSleepMinutes;
      if (typeof p.maxActive === 'number' && Number.isInteger(p.maxActive) && p.maxActive >= 1 && p.maxActive <= 32) clean.maxActive = p.maxActive;
      Object.assign(config, clean);
      saveConfig(paths, clean);
      await service.dequeue();
      return info();
    },
    maintenance: async () => {
      await service.sleepIdle();
      await service.refreshBaseAhead({ fetch: true });
      await service.pollPrs();
    },
  };
  const app = await buildApp({ service, hub, token, port: config.port, settings, webDir: dev ? null : webDir, dev, info, subscribe });
  try {
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Порт ${config.port} уже зайнятий — мабуть, Ватра вже працює: http://localhost:${config.port}`);
      console.error('Інший порт: VATRA_PORT=4318 vatra start (або "port" у config.json).');
    } else {
      console.error(`Не вдалося зайняти 127.0.0.1:${config.port}: ${(err as Error).message}`);
    }
    process.exit(1);
  }
  // reconcile after listen: hooks of running agents may call us right away
  await service.reconcile().catch((err) => console.error('[reconcile]', err));
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    service
      .sweep()
      .catch((err) => console.error('[sweep]', err))
      .finally(() => (sweeping = false));
  }, 3000).unref();
  // idle agents go to sleep; base branches are re-checked for new commits
  setInterval(() => void service.sleepIdle().catch((err) => console.error('[sleep]', err)), 60_000).unref();
  setInterval(() => void service.refreshBaseAhead({ fetch: true }).catch((err) => console.error('[base]', err)), 180_000).unref();
  setTimeout(() => void service.refreshBaseAhead({ fetch: true }).catch(() => {}), 8000).unref();
  // merged/closed PRs on GitHub close their tasks
  setInterval(() => void service.pollPrs().catch((err) => console.error('[pr]', err)), 120_000).unref();
  setTimeout(() => void service.pollPrs().catch(() => {}), 5000).unref();

  const url = dev ? `http://localhost:5173/?token=${token}` : `http://localhost:${config.port}`;
  console.log(`Ватра (Vatra) ${version} · ${url}`);
  console.log(`  дані: ${paths.dataDir} · tmux: ${tmuxVersion} (-L ${config.tmuxSocket}) · claude: ${claudeBin ?? '—'}`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  if (openUi && !dev) openBrowser(url);

  const shutdown = async (sig: string) => {
    console.log(`\n${sig}: зупиняюсь. Агенти лишаються жити в tmux і підхопляться при наступному старті.`);
    hub.closeAll();
    chat.closeAll();
    await watcher.closeAll();
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function check(label: string, fn: () => string | null) {
  try {
    const r = fn();
    console.log(`  ✓ ${label}${r ? `: ${r}` : ''}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${label}: ${(err as Error).message.split('\n')[0]}`);
    return false;
  }
}

async function doctor() {
  console.log(`Vatra ${version} · ${process.platform}/${process.arch} · node ${process.version}`);
  const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0];
  check('git', () => sh('git', ['--version']));
  check('tmux', () => sh('tmux', ['-V']));
  check('node-pty', () => {
    require('node-pty');
    return null;
  });
  check('better-sqlite3', () => {
    const D = require('better-sqlite3');
    new D(':memory:').close();
    return null;
  });
  const claude = await resolveClaudeBin(null);
  check('claude', () => {
    if (!claude) throw new Error('не знайдено в PATH');
    return `${claude} (${sh(claude, ['--version'])})`;
  });
  check('gh (для PR)', () => sh('gh', ['--version']));
  check('gh auth', () => {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return 'залогінено';
  });
  if (process.env.ANTHROPIC_API_KEY) console.log('  ! ANTHROPIC_API_KEY задано — сервер прибере його для агентів');
  const paths = getPaths();
  console.log(`  дані: ${paths.dataDir}`);
}

function serviceFiles() {
  const node = process.execPath;
  const entry = fileURLToPath(import.meta.url);
  const paths = getPaths();
  const PATH = process.env.PATH ?? '/usr/bin:/bin';
  if (platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', 'dev.vatra.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.vatra</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(paths.logsDir, 'server.log')}</string>
  <key>StandardErrorPath</key><string>${join(paths.logsDir, 'server.log')}</string>
</dict></plist>
`;
    return { file, content: plist };
  }
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'vatra.service');
  const unit = `[Unit]
Description=Vatra — parallel Claude Code agents
After=network.target

[Service]
ExecStart=${node} ${entry} start
Environment=PATH=${PATH}
Restart=on-failure
KillMode=process

[Install]
WantedBy=default.target
`;
  return { file, content: unit };
}

/** Removes the autostart entry of the pre-rename version (Local Delta), if any. */
function removeLegacyService() {
  try {
    if (platform === 'darwin') {
      const old = join(homedir(), 'Library', 'LaunchAgents', 'dev.localdelta.plist');
      if (!existsSync(old)) return;
      try {
        execFileSync('launchctl', ['unload', '-w', old], { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      rmSync(old, { force: true });
      console.log(`Прибрано старий автозапуск ${old}`);
    } else {
      const old = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'localdelta.service');
      if (!existsSync(old)) return;
      try {
        execFileSync('systemctl', ['--user', 'disable', '--now', 'localdelta.service'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
      rmSync(old, { force: true });
      console.log(`Прибрано старий автозапуск ${old}`);
    }
  } catch {
    /* best effort */
  }
}

function installService() {
  removeLegacyService();
  const { file, content } = serviceFiles();
  mkdirSync(dirname(file), { recursive: true });
  ensureDirs(getPaths());
  writeFileSync(file, content);
  console.log(`Записано ${file}`);
  try {
    if (platform === 'darwin') {
      try {
        execFileSync('launchctl', ['unload', file], { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      execFileSync('launchctl', ['load', '-w', file], { stdio: 'inherit' });
    } else {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'vatra.service'], { stdio: 'inherit' });
    }
    console.log('Сервіс запущено. UI: http://localhost:4317');
  } catch (err) {
    console.error(`Не вдалося запустити сервіс: ${(err as Error).message}`);
  }
}

function uninstallService() {
  const { file } = serviceFiles();
  try {
    if (platform === 'darwin') execFileSync('launchctl', ['unload', '-w', file], { stdio: 'inherit' });
    else execFileSync('systemctl', ['--user', 'disable', '--now', 'vatra.service'], { stdio: 'inherit' });
  } catch {
    /* ignore */
  }
  rmSync(file, { force: true });
  console.log(`Видалено ${file}. Агенти в tmux (-L vatra) не зачеплено.`);
}

function serverUrl(): string {
  const cfg = loadConfig(getPaths());
  return `http://localhost:${cfg.port}`;
}

function openBrowser(url: string) {
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => console.log(`Відкрий у браузері: ${url}`)).unref();
  } catch {
    console.log(`Відкрий у браузері: ${url}`);
  }
}

/** git pull + install + build in the install directory, then restart the service if there is one. */
function update() {
  if (!existsSync(join(pkgRoot, '.git'))) {
    console.error(`${pkgRoot} — не git-клон, оновлюй тим самим способом, яким встановлював.`);
    process.exit(1);
  }
  const run = (cmd: string, args: string[]) => {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { cwd: pkgRoot, stdio: 'inherit' });
  };
  run('git', ['pull', '--ff-only']);
  run('corepack', ['pnpm', 'install', '--frozen-lockfile']);
  run('corepack', ['pnpm', 'build']);
  const { file } = serviceFiles();
  if (existsSync(file)) {
    try {
      if (platform === 'darwin') execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/dev.vatra`], { stdio: 'inherit' });
      else execFileSync('systemctl', ['--user', 'restart', 'vatra.service'], { stdio: 'inherit' });
      console.log('Сервіс перезапущено.');
    } catch {
      console.log('Перезапусти сервер вручну, щоб підхопити нову версію.');
    }
  } else {
    console.log('Готово. Перезапусти `vatra start`, якщо сервер зараз працює.');
  }
}

const HELP = `Ватра (vatra) ${version} — паралельні агенти Claude Code в git worktrees

Використання: vatra <команда>

  start [--open]       запустити сервер (UI на ${'http://localhost:4317'}); --open відкриє браузер
  open                 відкрити UI в браузері
  doctor               перевірити git, tmux, claude, gh і нативні модулі
  selftest [--keep]    прогнати справжнього claude через запущену Ватру (довіра, хуки, дозволи, чат)
  update               git pull + install + build (і перезапуск сервісу)
  install-service      автозапуск у фоні (launchd / systemd --user)
  uninstall-service    прибрати автозапуск
  url                  надрукувати адресу UI
  version              версія
`;

const [cmd = 'start', ...rest] = process.argv.slice(2);
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`Потрібен Node.js 22+, зараз ${process.version}.`);
  process.exit(1);
}
switch (cmd) {
  case 'start':
    await start(rest.includes('--dev'), rest.includes('--open'));
    break;
  case 'open':
    openBrowser(serverUrl());
    break;
  case 'doctor':
    await doctor();
    break;
  case 'selftest':
    process.exit(await selftest({ keep: rest.includes('--keep') }));
  case 'update':
    update();
    break;
  case 'install-service':
    installService();
    break;
  case 'uninstall-service':
    uninstallService();
    break;
  case 'url':
    console.log(serverUrl());
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(version);
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  default:
    console.log(HELP);
    process.exit(1);
}
