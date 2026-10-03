import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as git from './git.js';
import { slugify, uniqueSlug } from './slug.js';

let dir: string;
let repo: string;

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ld-git-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('slug', () => {
  it('transliterates Ukrainian', () => {
    expect(slugify('Додати Логін через Google')).toBe('dodaty-lohin-cherez-google');
  });
  it('falls back to task', () => {
    expect(slugify('!!!')).toBe('task');
  });
  it('is unique', async () => {
    const taken = new Set(['fix', 'fix-2']);
    expect(await uniqueSlug('fix', (s) => taken.has(s))).toBe('fix-3');
  });
});

describe('github compare url', () => {
  it('handles ssh and https remotes', () => {
    expect(git.githubCompareUrl('git@github.com:acme/erp-backend.git', 'staging', 'feat/pnl-cell')).toBe(
      'https://github.com/acme/erp-backend/compare/staging...feat/pnl-cell?expand=1',
    );
    expect(git.githubCompareUrl('https://github.com/acme/erp-backend', 'main', 'agent/x')).toBe('https://github.com/acme/erp-backend/compare/main...agent/x?expand=1');
    expect(git.githubCompareUrl('git@gitlab.com:a/b.git', 'main', 'x')).toBeNull();
  });
});

describe('git layer', () => {
  it('detects default branch and root', async () => {
    expect(await git.repoRoot(repo)).toBe(execFileSync('realpath', [repo], { encoding: 'utf8' }).trim());
    expect(await git.detectDefaultBranch(repo)).toBe('main');
  });

  it('full cycle: worktree → diff → commit → merge → cleanup', async () => {
    const base = await git.revParse(repo, 'main');
    const wt = join(dir, 'wt', 'feat');
    await git.addWorktree(repo, wt, 'agent/feat', base);
    await git.addExcludes(wt, ['.claude/settings.local.json']);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/settings.local.json');

    writeFileSync(join(wt, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(wt, 'new.txt'), 'hello\n');
    const all = await git.diff(wt, base, 'agent/feat', 'all');
    expect(all.stats.files).toBe(2);
    expect(all.untracked).toEqual(['new.txt']);
    expect(all.patch).toContain('+TWO');
    expect(all.patch).toContain('+hello');

    const committedBefore = await git.diff(wt, base, 'agent/feat', 'committed');
    expect(committedBefore.stats.files).toBe(0);

    expect(await git.commitAll(wt, 'agent work')).toBe(true);
    expect(await git.isDirty(wt)).toBe(false);
    const committed = await git.diff(wt, base, 'agent/feat', 'committed');
    expect(committed.stats.files).toBe(2);
    const working = await git.diff(wt, base, 'agent/feat', 'working');
    expect(working.stats.files).toBe(0);

    const m = await git.merge(repo, 'agent/feat', 'merge', 'Merge agent/feat');
    expect(m.ok).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('TWO');

    await git.removeWorktree(repo, wt);
    await git.deleteBranch(repo, 'agent/feat', false);
    expect(existsSync(wt)).toBe(false);
    expect(await git.branchExists(repo, 'agent/feat')).toBe(false);
  });

  it('squash merge creates a single commit', async () => {
    const base = await git.revParse(repo, 'main');
    const wt = join(dir, 'wt', 'sq');
    await git.addWorktree(repo, wt, 'agent/sq', base);
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    await git.commitAll(wt, 'one');
    writeFileSync(join(wt, 'c.txt'), 'c\n');
    await git.commitAll(wt, 'two');
    const m = await git.merge(repo, 'agent/sq', 'squash', 'Squashed task');
    expect(m.ok).toBe(true);
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('Squashed task');
    expect(sh(repo, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('aborts on conflict and leaves repo clean', async () => {
    const base = await git.revParse(repo, 'main');
    const wt = join(dir, 'wt', 'c');
    await git.addWorktree(repo, wt, 'agent/c', base);
    writeFileSync(join(wt, 'a.txt'), 'one\nAGENT\nthree\n');
    await git.commitAll(wt, 'agent');
    writeFileSync(join(repo, 'a.txt'), 'one\nMAIN\nthree\n');
    sh(repo, 'commit', '-qam', 'main');
    for (const strategy of ['merge', 'squash'] as const) {
      const m = await git.merge(repo, 'agent/c', strategy, 'x');
      expect(m.ok).toBe(false);
      expect(m.conflict).toBe(true);
      expect(m.conflictedFiles).toEqual(['a.txt']);
      expect(await git.isDirty(repo)).toBe(false);
    }
  });

  it('lists worktrees', async () => {
    const base = await git.revParse(repo, 'main');
    const wt = join(dir, 'wt', 'l');
    await git.addWorktree(repo, wt, 'agent/l', base);
    const list = await git.listWorktrees(repo);
    expect(list.map((w) => w.branch)).toContain('agent/l');
  });
});
