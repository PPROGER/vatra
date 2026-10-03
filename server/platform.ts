// Everything that differs between macOS and Linux lives here.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type Platform = 'darwin' | 'linux';

export const platform: Platform = process.platform === 'darwin' ? 'darwin' : 'linux';

export function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

/** VATRA_<name>, falling back to the pre-rename LOCALDELTA_<name>. */
export function envVar(name: string): string | undefined {
  return process.env[`VATRA_${name}`] ?? process.env[`LOCALDELTA_${name}`] ?? undefined;
}

/**
 * ~/.vatra on macOS, $XDG_DATA_HOME/vatra on Linux. VATRA_HOME overrides both.
 * Data from before the rename (~/.localdelta) keeps being used if it exists.
 */
export function defaultDataDir(): string {
  const env = envVar('HOME');
  if (env) return env;
  const base = platform === 'darwin' ? homedir() : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const legacy = join(base, platform === 'darwin' ? '.localdelta' : 'localdelta');
  const fresh = join(base, platform === 'darwin' ? '.vatra' : 'vatra');
  if (!existsSync(fresh) && existsSync(legacy)) return legacy;
  return fresh;
}

function detached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best effort */
  }
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('/bin/sh', ['-c', `command -v ${cmd}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Escapes a string for an AppleScript string literal. */
function osaQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function notify(title: string, body: string): void {
  if (envVar('NO_NOTIFY')) return;
  if (platform === 'darwin') {
    detached('osascript', ['-e', `display notification ${osaQuote(body)} with title ${osaQuote(title)}`]);
  } else {
    detached('notify-send', ['-a', 'Ватра', title, body]);
  }
}

export type OpenTarget = 'zed' | 'files' | 'terminal';

export async function openIn(target: OpenTarget, path: string): Promise<void> {
  if (target === 'files') {
    detached(platform === 'darwin' ? 'open' : 'xdg-open', [path]);
    return;
  }
  if (target === 'zed') {
    const bin = (await which('zed')) ?? (await which('zeditor'));
    if (bin) return detached(bin, [path]);
    if (platform === 'darwin') return detached('open', ['-a', 'Zed', path]);
    throw new Error('Zed не знайдено в PATH (zed або zeditor)');
  }
  // terminal
  if (platform === 'darwin') {
    const app = envVar('TERMINAL_APP') || 'Terminal';
    return detached('open', ['-a', app, path]);
  }
  for (const [cmd, args] of [
    ['x-terminal-emulator', ['--working-directory', path]],
    ['gnome-terminal', ['--working-directory', path]],
    ['konsole', ['--workdir', path]],
    ['xfce4-terminal', ['--working-directory', path]],
    ['kitty', ['--directory', path]],
    ['alacritty', ['--working-directory', path]],
  ] as const) {
    if (await which(cmd)) return detached(cmd, [...args]);
  }
  throw new Error('Не знайдено емулятор термінала');
}

/**
 * Resolves the `claude` binary. Servers started by launchd/systemd often have a
 * minimal PATH, so fall back to the user's login shell.
 */
export async function resolveClaudeBin(override?: string | null): Promise<string | null> {
  if (override) return override;
  const direct = await which('claude');
  if (direct) return direct;
  const shell = process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const { stdout } = await execFileP(shell, ['-lic', 'command -v claude'], { timeout: 5000 });
    const line = stdout.trim().split('\n').pop()?.trim();
    if (line && line.startsWith('/')) return line;
  } catch {
    /* ignore */
  }
  for (const p of [join(homedir(), '.claude', 'local', 'claude'), join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try {
      await execFileP(p, ['--version'], { timeout: 5000 });
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** PATH from the user's login shell, so agents see the same tools as in a normal terminal. */
export async function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const { stdout } = await execFileP(shell, ['-lic', 'printf "__LDPATH__%s" "$PATH"'], { timeout: 5000 });
    const m = stdout.match(/__LDPATH__(.*)$/m);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export { which };
