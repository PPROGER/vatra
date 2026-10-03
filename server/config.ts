import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir, envVar } from './platform.js';

export interface Config {
  /** HTTP port (UI, API, WebSocket). Always bound to 127.0.0.1. */
  port: number;
  /** Max agents with a live session at once; the rest wait in `queued`. */
  maxActive: number;
  /** Inclusive range of PORT values handed to agents. */
  portRange: [number, number];
  /** Override path to the claude binary. */
  claudeBin: string | null;
  /** Extra CLI args for every claude launch, e.g. ["--model", "opus"]. */
  claudeArgs: string[];
  /** Bytes of terminal output kept per task for reconnecting browsers. */
  ringBufferBytes: number;
  /** tmux socket name (`tmux -L <name>`), isolates our sessions from yours. */
  tmuxSocket: string;
  /** Context window size for the usage bar. Max plan sessions: 1M. */
  contextWindow: number | null;
}

export const DEFAULT_CONFIG: Config = {
  port: 4317,
  maxActive: 4,
  portRange: [5100, 5199],
  claudeBin: null,
  claudeArgs: [],
  ringBufferBytes: 200 * 1024,
  tmuxSocket: 'vatra',
  contextWindow: 1_000_000,
};

export interface Paths {
  dataDir: string;
  dbFile: string;
  configFile: string;
  tokenFile: string;
  worktreesDir: string;
  logsDir: string;
  runDir: string;
  uploadsDir: string;
  tmuxConf: string;
}

export function getPaths(dataDir = defaultDataDir()): Paths {
  return {
    dataDir,
    dbFile: join(dataDir, 'state.db'),
    configFile: join(dataDir, 'config.json'),
    tokenFile: join(dataDir, 'token'),
    worktreesDir: join(dataDir, 'worktrees'),
    logsDir: join(dataDir, 'logs'),
    runDir: join(dataDir, 'run'),
    uploadsDir: join(dataDir, 'uploads'),
    tmuxConf: join(dataDir, 'tmux.conf'),
  };
}

export function ensureDirs(paths: Paths): void {
  for (const d of [paths.dataDir, paths.worktreesDir, paths.logsDir, paths.runDir, paths.uploadsDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(paths: Paths): Config {
  let fileCfg: Partial<Config> = {};
  if (existsSync(paths.configFile)) {
    try {
      fileCfg = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    } catch (err) {
      throw new Error(`Не вдалося прочитати ${paths.configFile}: ${(err as Error).message}`);
    }
  } else {
    writeFileSync(paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  const cfg: Config = { ...DEFAULT_CONFIG, ...fileCfg };
  if (envVar('PORT')) cfg.port = Number(envVar('PORT'));
  if (envVar('MAX_ACTIVE')) cfg.maxActive = Number(envVar('MAX_ACTIVE'));
  if (envVar('CLAUDE_BIN')) cfg.claudeBin = envVar('CLAUDE_BIN')!;
  if (envVar('TMUX_SOCKET')) cfg.tmuxSocket = envVar('TMUX_SOCKET')!;
  // the window bar used to default to a model guess; Max plan sessions have 1M
  if (cfg.contextWindow === null && fileCfg.contextWindow === null) cfg.contextWindow = DEFAULT_CONFIG.contextWindow;
  return cfg;
}

/** Random token required by every API call and WebSocket. Stable across restarts. */
export function loadToken(paths: Paths): string {
  if (existsSync(paths.tokenFile)) {
    const t = readFileSync(paths.tokenFile, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(24).toString('hex');
  writeFileSync(paths.tokenFile, t + '\n', { mode: 0o600 });
  return t;
}
