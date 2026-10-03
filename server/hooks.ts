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

export function hookCommand(url: string): string {
  // Hooks receive JSON on stdin; forward it as-is. Never fail or slow the agent down.
  return `curl -s -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- ${shQuote(url)} >/dev/null 2>&1 || true # ${MARKER}`;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export function writeHooks(worktree: string, port: number, taskId: number, token: string): void {
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
    const entry: HookEntry = { hooks: [{ type: 'command', command: hookCommand(hookUrl(port, taskId, token, event)), timeout: 5 }] };
    if (event === 'PostToolUse' || event === 'PreToolUse') entry.matcher = '*';
    hooks[event] = [...kept, entry];
  }
  settings.hooks = hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
