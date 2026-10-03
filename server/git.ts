// Thin, explicit wrapper around the git CLI. Every operation the server does to
// a repository goes through here, so the git-level behaviour is easy to audit.
import { tr } from './shared/i18n/index.js';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DiffMode, DiffResult } from './shared/types.js';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export function run(
  cwd: string,
  args: string[],
  opts: { timeout?: number; okCodes?: number[]; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((res, rej) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, ...GIT_ENV, ...opts.env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout ?? 60_000,
      },
      (err, stdout, stderr) => {
        // execFile reports the exit status as a numeric `code`; spawn failures and timeouts are non-numeric
        const rawCode = err ? (err as unknown as { code?: unknown }).code : 0;
        const code = typeof rawCode === 'number' ? rawCode : -1;
        if (!err || okCodes.includes(code)) {
          res({ stdout: String(stdout), stderr: String(stderr), code });
          return;
        }
        const msg = String(stderr).trim() || String(stdout).trim() || err.message;
        rej(new GitError(`git ${args.join(' ')}: ${msg}`, args, code, String(stdout), String(stderr)));
      },
    );
  });
}

async function out(cwd: string, args: string[], timeout?: number): Promise<string> {
  return (await run(cwd, args, { timeout })).stdout.trim();
}

// ---------------------------------------------------------------- repo info

export async function repoRoot(path: string): Promise<string> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(tr('Шлях не існує: {path}', { path: abs }));
  try {
    return await out(abs, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(tr('Не git-репозиторій: {path}', { path: abs }));
  }
}

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await run(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function detectDefaultBranch(repo: string): Promise<string> {
  const r = await run(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { okCodes: [0, 1, 128] });
  if (r.code === 0 && r.stdout.trim()) {
    const b = r.stdout.trim().replace(/^origin\//, '');
    if (await branchExists(repo, b)) return b;
  }
  for (const b of ['main', 'master']) if (await branchExists(repo, b)) return b;
  const cur = await currentBranch(repo);
  if (cur) return cur;
  throw new Error(tr('Не вдалося визначити основну гілку'));
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [0, 1] });
  return r.code === 0;
}

/** Unix time of the oldest reflog entry of a branch (≈ when it was created), or null. */
export async function branchCreatedAt(repo: string, branch: string): Promise<number | null> {
  // %gd with --date=unix prints refs/heads/<b>@{<unix time of the reflog entry>}
  const r = await run(repo, ['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${branch}`, '--'], { okCodes: [0, 128] });
  if (r.code !== 0) return null;
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const m = lines[lines.length - 1]?.match(/@\{(\d+)\}$/);
  return m ? Number(m[1]) : null;
}

export async function listBranches(repo: string): Promise<string[]> {
  const s = await out(repo, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']);
  return s ? s.split('\n') : [];
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return out(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export async function hasRemote(repo: string): Promise<boolean> {
  return (await out(repo, ['remote'])).length > 0;
}

/** `git fetch` that never blocks task creation for long and never fails it. */
export async function fetchQuiet(repo: string): Promise<string | null> {
  if (!(await hasRemote(repo))) return null;
  try {
    await run(repo, ['fetch', '--quiet', '--prune'], { timeout: 30_000 });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The shared .git directory (same for the main checkout and all worktrees). */
export async function commonDir(path: string): Promise<string> {
  const d = await out(path, ['rev-parse', '--git-common-dir']);
  return isAbsolute(d) ? d : resolve(path, d);
}

/** Per-worktree git dir (holds HEAD and index of that worktree). */
export async function gitDir(path: string): Promise<string> {
  const d = await out(path, ['rev-parse', '--git-dir']);
  return isAbsolute(d) ? d : resolve(path, d);
}

/** Adds patterns to .git/info/exclude (shared by every worktree) if missing. */
export async function addExcludes(path: string, patterns: string[]): Promise<void> {
  const file = join(await commonDir(path), 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(current.split('\n').map((l) => l.trim()));
  const missing = patterns.filter((p) => !lines.has(p));
  if (!missing.length) return;
  const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(file, prefix + '# vatra\n' + missing.join('\n') + '\n');
}

// ---------------------------------------------------------------- worktrees

export async function addWorktree(repo: string, path: string, branch: string, commit: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await run(repo, ['worktree', 'add', '-b', branch, path, commit]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  if (existsSync(path)) {
    await run(repo, ['worktree', 'remove', '--force', '--force', path], { okCodes: [0, 128] });
  }
  await prune(repo);
}

export async function prune(repo: string): Promise<void> {
  await run(repo, ['worktree', 'prune'], { okCodes: [0, 128] });
}

export async function deleteBranch(repo: string, branch: string, force: boolean): Promise<void> {
  if (!(await branchExists(repo, branch))) return;
  await run(repo, ['branch', force ? '-D' : '-d', branch]);
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const s = await out(repo, ['worktree', 'list', '--porcelain']);
  const result: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of s.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null };
      result.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return result;
}

// ---------------------------------------------------------------- status / commit

/** Porcelain status lines. `untracked=false` ignores untracked files (merge safety check). */
export async function statusPorcelain(path: string, untracked = true): Promise<string[]> {
  const s = await out(path, ['status', '--porcelain', `--untracked-files=${untracked ? 'all' : 'no'}`]);
  return s ? s.split('\n') : [];
}

export async function isDirty(path: string, untracked = true): Promise<boolean> {
  return (await statusPorcelain(path, untracked)).length > 0;
}

async function identityArgs(cwd: string): Promise<string[]> {
  const r = await run(cwd, ['config', 'user.email'], { okCodes: [0, 1] });
  if (r.stdout.trim()) return [];
  return ['-c', 'user.name=Vatra', '-c', 'user.email=vatra@localhost'];
}

/** `git add -A && git commit`. Returns false when there was nothing to commit. */
export async function commitAll(path: string, message: string): Promise<boolean> {
  if (!(await isDirty(path))) return false;
  await run(path, ['add', '-A']);
  await run(path, [...(await identityArgs(path)), 'commit', '--no-verify', '-m', message]);
  return true;
}

export async function aheadCount(repo: string, base: string, branch: string): Promise<number> {
  return Number(await out(repo, ['rev-list', '--count', `${base}..${branch}`]));
}

// ---------------------------------------------------------------- diff

const MAX_PATCH_BYTES = 6 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 300;
const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--find-renames'];

async function untrackedFiles(wt: string): Promise<string[]> {
  const s = (await run(wt, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
  return s.split('\0').filter(Boolean);
}

async function untrackedPatch(wt: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files.slice(0, MAX_UNTRACKED_FILES)) {
    const abs = join(wt, f);
    let size = 0;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_UNTRACKED_FILE_BYTES) {
      parts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\nBinary files /dev/null and b/${f} differ\n`);
      continue;
    }
    // exit code 1 = "files differ", which is the expected outcome here
    const r = await run(wt, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', f], { okCodes: [0, 1] });
    parts.push(r.stdout);
  }
  return parts.join('');
}

export function patchStats(patch: string): DiffResult['stats'] {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { files, additions, deletions };
}

/**
 * committed: what the agent committed  — git diff <base>...<branch>
 * working:   uncommitted changes        — git diff HEAD + untracked
 * all:       everything vs base         — git diff <base> + untracked
 */
export async function diff(wt: string, baseCommit: string, branch: string, mode: DiffMode): Promise<DiffResult> {
  let patch = '';
  let untracked: string[] = [];
  if (mode === 'committed') {
    patch = (await run(wt, ['diff', ...DIFF_FLAGS, `${baseCommit}...${branch}`])).stdout;
  } else {
    const against = mode === 'working' ? 'HEAD' : baseCommit;
    patch = (await run(wt, ['diff', ...DIFF_FLAGS, against])).stdout;
    untracked = await untrackedFiles(wt);
    patch += await untrackedPatch(wt, untracked);
  }
  let truncated = false;
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    patch = Buffer.from(patch).subarray(0, MAX_PATCH_BYTES).toString('utf8');
    patch = patch.slice(0, patch.lastIndexOf('\ndiff --git ') + 1) || patch;
    truncated = true;
  }
  return { mode, baseCommit, patch, untracked, stats: patchStats(patch), truncated };
}

// ---------------------------------------------------------------- merge

export type MergeStrategy = 'merge' | 'squash';

export interface MergeOutcome {
  ok: boolean;
  conflict: boolean;
  conflictedFiles: string[];
  output: string;
  commit?: string;
}

/**
 * Merges `branch` into the branch currently checked out in `repo`.
 * On conflict the merge is aborted and the repo is left exactly as before.
 */
export async function merge(repo: string, branch: string, strategy: MergeStrategy, message: string): Promise<MergeOutcome> {
  const id = await identityArgs(repo);
  const args = strategy === 'squash' ? [...id, 'merge', '--squash', branch] : [...id, 'merge', '--no-ff', '--no-edit', '-m', message, branch];
  const r = await run(repo, args, { okCodes: [0, 1, 128] });
  const output = (r.stdout + r.stderr).trim();
  if (r.code !== 0) {
    const conflicted = (await run(repo, ['diff', '--name-only', '--diff-filter=U'], { okCodes: [0, 1, 128] })).stdout
      .split('\n')
      .filter(Boolean);
    // squash leaves no MERGE_HEAD, so `merge --abort` would fail; reset --merge works for both
    await run(repo, ['merge', '--abort'], { okCodes: [0, 128] });
    await run(repo, ['reset', '--merge'], { okCodes: [0, 128] });
    return { ok: false, conflict: conflicted.length > 0 || /CONFLICT/.test(output), conflictedFiles: conflicted, output };
  }
  if (strategy === 'squash') {
    const staged = await run(repo, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] });
    if (staged.code === 0) return { ok: true, conflict: false, conflictedFiles: [], output: tr('Немає змін для злиття') };
    await run(repo, [...id, 'commit', '--no-verify', '-m', message]);
  }
  const commit = await out(repo, ['rev-parse', 'HEAD']);
  return { ok: true, conflict: false, conflictedFiles: [], output, commit };
}

// ---------------------------------------------------------------- remote / PR

export async function push(wt: string, branch: string): Promise<string> {
  const r = await run(wt, ['push', '--force-with-lease', '-u', 'origin', branch], { timeout: 120_000 });
  return (r.stdout + r.stderr).trim();
}

/** Remote-tracking ref of a branch on origin after `git fetch`, if it exists. */
export async function remoteBranchSha(dir: string, branch: string): Promise<string | null> {
  const r = await run(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Plain (non-force) push of a branch to origin. */
export async function pushBranch(dir: string, branch: string): Promise<RunResult> {
  return run(dir, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeout: 120_000, okCodes: [0, 1, 128] });
}

export async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  const r = await run(dir, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1, 128] });
  return r.code === 0;
}

export async function refExists(dir: string, ref: string): Promise<boolean> {
  const r = await run(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okCodes: [0, 1, 128] });
  return r.code === 0;
}

export async function remoteUrl(repo: string, remote = 'origin'): Promise<string | null> {
  const r = await run(repo, ['remote', 'get-url', remote], { okCodes: [0, 2, 128] });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** "Open a pull request" page on GitHub for base ← branch, or null for other hosts. */
export function githubCompareUrl(remote: string | null, base: string, branch: string): string | null {
  if (!remote) return null;
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${m[1]}/${m[2]}/compare/${enc(base)}...${enc(branch)}?expand=1`;
}

export function slugBase(path: string): string {
  return basename(path);
}
