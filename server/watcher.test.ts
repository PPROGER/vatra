import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiffWatcher, isIgnoredPath } from './watcher';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fds = () => (process.platform === 'linux' ? readdirSync('/proc/self/fd').length : 0);

describe('worktree watcher', () => {
  it('ignores dependency/build dirs', () => {
    expect(isIgnoredPath('node_modules/x/index.js')).toBe(true);
    expect(isIgnoredPath('src/app.ts')).toBe(false);
    expect(isIgnoredPath('packages/a/dist/x.js')).toBe(true);
  });

  it('reports changes in nested folders without a file descriptor per file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vatra-watch-'));
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(root, 'src', `d${d}`), { recursive: true });
      for (let f = 0; f < 50; f++) writeFileSync(join(root, 'src', `d${d}`, `f${f}.ts`), 'x');
    }
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    const before = fds();
    const seen: number[] = [];
    const w = new DiffWatcher((id) => seen.push(id), 50);
    w.watch(7, root, null);
    await sleep(800);
    expect(fds() - before).toBeLessThan(50); // 1000 files, a handful of descriptors
    // FSEvents on macOS can still deliver the setup writes from just before watching started
    seen.length = 0;

    writeFileSync(join(root, 'node_modules', 'pkg', 'a.js'), 'y');
    await sleep(600);
    expect(seen).toEqual([]);

    writeFileSync(join(root, 'src', 'd3', 'f1.ts'), 'changed');
    for (let i = 0; i < 30 && !seen.length; i++) await sleep(100);
    expect(seen).toContain(7);
    await w.unwatch(7);
    expect(w.watching(7)).toBe(false);
  });
});
