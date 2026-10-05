// Watches agent worktrees and emits a debounced "diff changed" signal.
//
// One recursive fs.watch per worktree (FSEvents on macOS, a single inotify instance on
// Linux) plus one for the worktree's git dir. Per-file watchers (what chokidar does without
// fsevents) cost a file descriptor per file on macOS: a few big worktrees exhaust the
// process limit and then every spawn fails with EBADF.
import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache', 'dist', 'build', 'coverage', '.venv', '__pycache__', 'target', 'vendor', '.nuxt', '.svelte-kit', '.pnpm-store', '.gradle', '.idea', 'tmp', 'log', 'logs']);

/** True when a path (relative to the worktree) is inside a directory we don't care about. */
export function isIgnoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part));
}

interface Entry {
  watchers: FSWatcher[];
  timer?: NodeJS.Timeout;
}

export class DiffWatcher {
  private entries = new Map<number, Entry>();

  constructor(
    private readonly onChange: (taskId: number) => void,
    private readonly debounceMs = 500,
  ) {}

  /** @param gitDir the worktree's own git dir; its HEAD/index change on commit/add. */
  watch(taskId: number, worktree: string, gitDir: string | null): void {
    if (this.entries.has(taskId)) return;
    const entry: Entry = { watchers: [] };
    const fire = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(taskId), this.debounceMs);
    };
    const add = (path: string, recursive: boolean, filter?: (name: string) => boolean) => {
      try {
        const w = watch(path, { recursive, persistent: false }, (_ev, name) => {
          const n = name ? String(name) : '';
          if (!filter || !n || filter(n)) fire();
        });
        w.on('error', (err) => console.warn(`[watch] task ${taskId}: ${err.message}`));
        entry.watchers.push(w);
        return true;
      } catch (err) {
        console.warn(`[watch] task ${taskId}: ${(err as Error).message}`);
        return false;
      }
    };
    // fall back to watching only the top level where recursive watching isn't available
    if (!add(worktree, true, (n) => !isIgnoredPath(n))) add(worktree, false, (n) => !isIgnoredPath(n));
    if (gitDir && !gitDir.startsWith(worktree + sep)) add(gitDir, false, (n) => n === 'HEAD' || n === 'index');
    this.entries.set(taskId, entry);
  }

  watching(taskId: number): boolean {
    return this.entries.has(taskId);
  }

  async unwatch(taskId: number): Promise<void> {
    const e = this.entries.get(taskId);
    if (!e) return;
    clearTimeout(e.timer);
    this.entries.delete(taskId);
    for (const w of e.watchers) w.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.unwatch(id)));
  }
}
