// Claude Code runs hooks only in folders whose "trust this folder?" dialog was accepted
// (~/.claude.json → projects[<path>].hasTrustDialogAccepted). Every task gets a brand-new
// worktree path, and with some settings (e.g. IS_DEMO) the dialog is never shown — so the
// folder stays untrusted and claude silently skips every hook. Vatra therefore carries the
// trust you already gave the repository over to its worktrees.
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function claudeConfigFile(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

type Projects = Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>>;

function load(file: string): { data: Record<string, unknown>; projects: Projects } | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;
    const projects = (data.projects && typeof data.projects === 'object' ? data.projects : {}) as Projects;
    return { data, projects };
  } catch {
    return null;
  }
}

/** Whether claude trusts this folder (the folder itself or one of its parents was accepted). */
export function isTrusted(path: string, file = claudeConfigFile()): boolean {
  const cfg = load(file);
  if (!cfg) return false;
  for (let p = real(path); ; p = dirname(p)) {
    if (cfg.projects[p]?.hasTrustDialogAccepted) return true;
    if (dirname(p) === p) return false;
  }
}

function save(file: string, data: Record<string, unknown>) {
  // claude rewrites this file itself; write atomically so a reader never sees half a file
  const tmp = `${file}.vatra-${process.pid}`;
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    /* keep default */
  }
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  renameSync(tmp, file);
}

/** Marks a folder as trusted (true) or forgets it (false). Returns true if the file changed. */
export function setTrust(path: string, trusted: boolean, file = claudeConfigFile()): boolean {
  const cfg = load(file);
  if (!cfg) return false;
  const key = real(path);
  if (trusted) {
    if (cfg.projects[key]?.hasTrustDialogAccepted) return false;
    cfg.projects[key] = { ...(cfg.projects[key] ?? {}), hasTrustDialogAccepted: true };
  } else {
    if (!(key in cfg.projects)) return false;
    delete cfg.projects[key];
  }
  cfg.data.projects = cfg.projects;
  save(file, cfg.data);
  return true;
}

/**
 * Marks the worktree as trusted when the repository it was made from is trusted.
 * Returns true if the file was changed.
 */
export function inheritTrust(repoPath: string, worktreePath: string, file = claudeConfigFile()): boolean {
  if (!isTrusted(repoPath, file)) return false;
  return setTrust(worktreePath, true, file);
}
