// Watches agent worktrees and emits a debounced "diff changed" signal.
import chokidar, { type FSWatcher } from 'chokidar';
import { join, sep } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache', 'dist', 'build', 'coverage', '.venv', '__pycache__', 'target']);

function isIgnored(path: string, root: string): boolean {
  if (!path.startsWith(root)) return false;
  const rel = path.slice(root.length);
  return rel.split(sep).some((part) => IGNORED_DIRS.has(part));
}

export class DiffWatcher {
  private watchers = new Map<number, { fs: FSWatcher; timer?: NodeJS.Timeout }>();

  constructor(
    private readonly onChange: (taskId: number) => void,
    private readonly debounceMs = 500,
  ) {}

  /** @param gitDir the worktree's own git dir; its HEAD/index change on commit/add. */
  watch(taskId: number, worktree: string, gitDir: string | null): void {
    if (this.watchers.has(taskId)) return;
    const paths = [worktree];
    if (gitDir) paths.push(join(gitDir, 'HEAD'), join(gitDir, 'index'));
    const fs = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => isIgnored(p, worktree) && !(gitDir && p.startsWith(gitDir)),
      awaitWriteFinish: false,
    });
    const entry: { fs: FSWatcher; timer?: NodeJS.Timeout } = { fs };
    const fire = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(taskId), this.debounceMs);
    };
    fs.on('all', fire);
    fs.on('error', (err) => {
      // inotify limits on Linux: keep the server alive, the UI can still refresh manually
      console.warn(`[watch] task ${taskId}: ${(err as Error).message}`);
    });
    this.watchers.set(taskId, entry);
  }

  async unwatch(taskId: number): Promise<void> {
    const w = this.watchers.get(taskId);
    if (!w) return;
    clearTimeout(w.timer);
    this.watchers.delete(taskId);
    await w.fs.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((id) => this.unwatch(id)));
  }
}
