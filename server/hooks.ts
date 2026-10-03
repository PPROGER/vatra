// Writes `.claude/settings.local.json` into a worktree so Claude Code reports
// its state back to the server. The file is git-excluded, never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shQuote } from './tmux.js';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const SETTINGS_REL = '.claude/settings.local.json';
const MARKER = 'vatra-hook';
const LEGACY_MARKER = 'localdelta-hook';

export function hookUrl(port: number, taskId: number, token: string, event: string): string {
  return `http://127.0.0.1:${port}/api/hooks/${taskId}?event=${event}&token=${token}`;
}

/** Where a hook command leaves traces for `vatra selftest`: a marker that claude ran it and a log of failed calls. */
export interface HookTrace {
  ranFile: string;
  logFile: string;
  /** Touched by the launcher right before it execs claude (after the setup script). */
  startedFile: string;
}

export function hookTrace(runDir: string, taskId: number): HookTrace {
  return { ranFile: join(runDir, `hooks-${taskId}.ran`), logFile: join(runDir, `hooks-${taskId}.log`), startedFile: join(runDir, `hooks-${taskId}.started`) };
}

/** curl that ignores proxy settings: the server is always on 127.0.0.1. */
export function curlPost(url: string, data = '@-'): string {
  return `curl --noproxy '*' -s -m 3 -X POST -H 'Content-Type: application/json' --data-binary ${data === '@-' ? '@-' : shQuote(data)} ${shQuote(url)}`;
}

export function hookCommand(url: string, trace?: HookTrace, event = ''): string {
  // Hooks receive JSON on stdin; forward it as-is. Never fail or slow the agent down.
  if (!trace) return `${curlPost(url)} >/dev/null 2>&1 || true # ${MARKER}`;
  return `${curlPost(url)} >/dev/null 2>&1 || echo "$(date '+%F %T') ${event} curl exit $?" >> ${shQuote(trace.logFile)}; touch ${shQuote(trace.ranFile)} # ${MARKER}`;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

/** Our hooks as a settings object (also passed to claude with --settings, see writeHooks). */
export function hookSettings(port: number, taskId: number, token: string, trace?: HookTrace): { hooks: Record<string, HookEntry[]> } {
  const hooks: Record<string, HookEntry[]> = {};
  for (const event of HOOK_EVENTS) {
    const entry: HookEntry = { hooks: [{ type: 'command', command: hookCommand(hookUrl(port, taskId, token, event), trace, event), timeout: 5 }] };
    if (event === 'PostToolUse' || event === 'PreToolUse') entry.matcher = '*';
    hooks[event] = [entry];
  }
  return { hooks };
}

/**
 * Registers the hooks twice: in the worktree's `.claude/settings.local.json` and in a
 * separate file for `claude --settings <file>` (returned). Claude Code de-duplicates identical
 * commands, and the flag file still works when project settings are ignored.
 */
export function writeHooks(worktree: string, port: number, taskId: number, token: string, runDir?: string): string | null {
  const trace = runDir ? hookTrace(runDir, taskId) : undefined;
  const ours = hookSettings(port, taskId, token, trace).hooks;
  const file = join(worktree, SETTINGS_REL);
  mkdirSync(join(worktree, '.claude'), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      settings = {};
    }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  for (const event of HOOK_EVENTS) {
    // drop our previous entries (port/token may have changed), keep the user's own
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !h.command?.includes(MARKER) && !h.command?.includes(LEGACY_MARKER)) }))
      .filter((e) => e.hooks.length > 0);
    hooks[event] = [...kept, ...ours[event]];
  }
  settings.hooks = hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  if (!runDir) return null;
  const flagFile = join(runDir, `hooks-${taskId}.json`);
  writeFileSync(flagFile, JSON.stringify({ hooks: ours }, null, 2) + '\n', { mode: 0o600 });
  return flagFile;
}
