import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inheritTrust, isTrusted, setTrust } from './claudetrust';

describe('claude folder trust', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vatra-trust-')));
  const file = join(dir, '.claude.json');
  const repo = join(dir, 'repo');
  const wt = join(dir, 'wt');
  mkdirSync(repo);
  mkdirSync(wt);

  it('passes the repository trust on to its worktree, keeping everything else', () => {
    writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { [repo]: { hasTrustDialogAccepted: true, allowedTools: [] } } }));
    expect(isTrusted(wt, file)).toBe(false);
    expect(inheritTrust(repo, wt, file)).toBe(true);
    expect(isTrusted(wt, file)).toBe(true);
    expect(inheritTrust(repo, wt, file)).toBe(false); // already trusted
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data.numStartups).toBe(3);
    expect(data.projects[repo].allowedTools).toEqual([]);
  });

  it('does not trust a worktree of an untrusted repository', () => {
    writeFileSync(file, JSON.stringify({ projects: {} }));
    expect(inheritTrust(repo, wt, file)).toBe(false);
    expect(isTrusted(wt, file)).toBe(false);
  });

  it('a trusted parent folder counts; setTrust(false) forgets', () => {
    writeFileSync(file, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    expect(inheritTrust(repo, wt, file)).toBe(true);
    expect(setTrust(wt, false, file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[wt]).toBeUndefined();
  });

  it('leaves a missing or broken config alone', () => {
    expect(inheritTrust(repo, wt, join(dir, 'nope.json'))).toBe(false);
    writeFileSync(file, '{broken');
    expect(inheritTrust(repo, wt, file)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
});
