// Folder picking for "Add project": native OS dialog, a directory browser
// and a quick scan for git repositories in the usual places.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as git from './git.js';
import { platform, which } from './platform.js';

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
  hidden: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  isGit: boolean;
  shortcuts: { label: string; path: string }[];
}

export interface RepoInspect {
  path: string;
  isGit: boolean;
  root: string | null;
  name: string;
  defaultBranch: string | null;
  suggestedSetup: string | null;
  envFiles: string[];
}

export function expandHome(p: string): string {
  const h = homedir();
  if (!p || p === '~') return h;
  if (p.startsWith('~/')) return join(h, p.slice(2));
  return resolve(p);
}

const isGitDir = (p: string) => existsSync(join(p, '.git'));

function shortcuts(): { label: string; path: string }[] {
  const h = homedir();
  const list = [
    { label: 'Домівка', path: h },
    { label: 'Documents', path: join(h, 'Documents') },
    { label: 'projects', path: join(h, 'Documents', 'projects') },
    { label: 'Projects', path: join(h, 'Projects') },
    { label: 'Developer', path: join(h, 'Developer') },
    { label: 'code', path: join(h, 'code') },
    { label: 'dev', path: join(h, 'dev') },
    { label: 'src', path: join(h, 'src') },
    { label: 'Desktop', path: join(h, 'Desktop') },
  ];
  return list.filter((s) => {
    try {
      return statSync(s.path).isDirectory();
    } catch {
      return false;
    }
  });
}

export function listDir(raw: string | undefined, showHidden = false): DirListing {
  const path = expandHome(raw || '~');
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`Папки не існує: ${path}`);
  }
  if (!st.isDirectory()) throw new Error(`Це не папка: ${path}`);
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch (err) {
    throw new Error(`Немає доступу до ${path}: ${(err as Error).message}`);
  }
  const entries: DirEntry[] = [];
  for (const name of names) {
    const hidden = name.startsWith('.');
    if (hidden && !showHidden) continue;
    if (name === 'node_modules') continue;
    const full = join(path, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ name, path: full, isGit: isGitDir(full), hidden });
  }
  entries.sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = dirname(path) === path ? null : dirname(path);
  return { path, parent, entries, isGit: isGitDir(path), shortcuts: shortcuts() };
}

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', '.Trash', 'vendor', 'dist', 'build', '.cache', '.npm', '.nvm', '.local', '.config']);

/** Git repos under the usual code folders, depth-limited and time-boxed. */
export function scanRepos(maxDepth = 3, budgetMs = 1500): { name: string; path: string }[] {
  const h = homedir();
  const roots = ['Documents', 'Projects', 'projects', 'Developer', 'code', 'dev', 'src', 'work', 'repos', 'Desktop', 'Sites', 'go/src', 'workspace']
    .map((d) => join(h, d))
    .filter((p) => existsSync(p));
  const found = new Map<string, string>();
  const deadline = Date.now() + budgetMs;
  const walk = (dir: string, depth: number) => {
    if (Date.now() > deadline || found.size >= 200) return;
    if (isGitDir(dir)) {
      found.set(dir, basename(dir));
      return; // don't descend into repos
    }
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith('.') || SKIP.has(n)) continue;
      const full = join(dir, n);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        /* skip */
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return [...found].map(([path, name]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Detects repo root, branch, a sensible setup command and untracked env files. */
export async function inspect(raw: string): Promise<RepoInspect> {
  const path = expandHome(raw);
  let root: string | null = null;
  let defaultBranch: string | null = null;
  try {
    root = await git.repoRoot(path);
    defaultBranch = await git.detectDefaultBranch(root);
  } catch {
    root = null;
  }
  const base = root ?? path;
  const has = (f: string) => existsSync(join(base, f));
  let suggestedSetup: string | null = null;
  if (has('pnpm-lock.yaml')) suggestedSetup = 'pnpm install --prefer-offline';
  else if (has('bun.lockb') || has('bun.lock')) suggestedSetup = 'bun install';
  else if (has('yarn.lock')) suggestedSetup = 'yarn install';
  else if (has('package-lock.json')) suggestedSetup = 'npm ci';
  else if (has('package.json')) suggestedSetup = 'npm install';
  else if (has('uv.lock')) suggestedSetup = 'uv sync';
  else if (has('poetry.lock')) suggestedSetup = 'poetry install';
  else if (has('Gemfile.lock')) suggestedSetup = 'bundle install';
  else if (has('go.mod')) suggestedSetup = 'go mod download';
  else if (has('composer.lock')) suggestedSetup = 'composer install';

  const envFiles: string[] = [];
  try {
    for (const n of readdirSync(base)) {
      if (/^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n) && statSync(join(base, n)).isFile()) envFiles.push(n);
    }
  } catch {
    /* ignore */
  }
  // also common nested env files in monorepos (apps/*/.env)
  for (const dir of ['apps', 'packages', 'services']) {
    const d = join(base, dir);
    if (!existsSync(d)) continue;
    try {
      for (const sub of readdirSync(d)) {
        for (const f of ['.env', '.env.local']) {
          if (existsSync(join(d, sub, f))) envFiles.push(`${dir}/${sub}/${f}`);
        }
      }
    } catch {
      /* ignore */
    }
  }
  let name = basename(base);
  try {
    const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name && !pkg.name.startsWith('@')) name = pkg.name;
  } catch {
    /* no package.json */
  }
  return { path, isGit: !!root, root, name, defaultBranch, suggestedSetup, envFiles };
}

/** Opens the OS folder chooser. Resolves null when the user cancels. */
export async function pickFolderNative(start?: string): Promise<string | null> {
  const run = (cmd: string, args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((res) => {
      execFile(cmd, args, { timeout: 10 * 60_000 }, (e, stdout, stderr) => {
        const raw = e ? (e as unknown as { code?: unknown }).code : 0;
        res({ code: typeof raw === 'number' ? raw : e ? -1 : 0, out: String(stdout).trim(), err: String(stderr).trim() });
      });
    });
  const startDir = start && existsSync(expandHome(start)) ? expandHome(start) : join(homedir(), 'Documents');

  if (platform === 'darwin') {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const choose = `set f to choose folder with prompt "Обери git-репозиторій для Ватри" default location (POSIX file "${esc(startDir)}")`;
    // Run the dialog inside System Events so it comes to the front above the browser.
    const front = ['tell application "System Events"', 'activate', choose, 'end tell', 'POSIX path of f'];
    let r = await run('osascript', front.flatMap((l) => ['-e', l]));
    if (r.code !== 0 && /-1743|-10004|not allowed|privilege/i.test(r.err)) {
      // no Automation permission for System Events: a plain dialog still works (may open behind windows)
      r = await run('osascript', [choose, 'POSIX path of f'].flatMap((l) => ['-e', l]));
    }
    if (r.code !== 0) {
      if (/-128|User canceled|скасовано/i.test(r.err)) return null;
      throw new Error(`Системний діалог не відкрився: ${r.err || r.code}`);
    }
    return r.out.replace(/\/$/, '') || null;
  }

  if (await which('zenity')) {
    const r = await run('zenity', ['--file-selection', '--directory', '--title=Обери git-репозиторій', `--filename=${startDir}/`]);
    return r.code === 0 ? r.out || null : null;
  }
  if (await which('kdialog')) {
    const r = await run('kdialog', ['--getexistingdirectory', startDir, '--title', 'Обери git-репозиторій']);
    return r.code === 0 ? r.out || null : null;
  }
  throw new Error('Немає zenity або kdialog — скористайся вбудованим оглядачем');
}
