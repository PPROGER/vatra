// Every string passed to t()/tr()/tk() must have an English translation.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN, tr } from './shared/i18n/index.js';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'i18n' || n === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) && !n.endsWith('.test.ts') ? [p] : [];
  });
}

const CALL = /\b(?:t|tr|tk)\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

describe('i18n', () => {
  const root = join(__dirname, '..');
  const used = new Map<string, string>();
  for (const f of [...files(join(root, 'server')), ...files(join(root, 'web', 'src'))]) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(CALL)) {
      if (m[1] === '`' && m[2].includes('${')) throw new Error(`${f}: template literal with \${} inside t()/tr() — use {placeholders}: ${m[2]}`);
      const key = m[2].replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');
      if (/[Ѐ-ӿ]/.test(key)) used.set(key, f);
    }
  }

  it('finds translatable strings', () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it('has an English translation for every string', () => {
    const missing = [...used].filter(([k]) => !(k in EN)).map(([k, f]) => `${f}: ${JSON.stringify(k)}`);
    expect(missing).toEqual([]);
  });

  it('keeps placeholders in translations', () => {
    const bad = Object.entries(EN).filter(([uk, en]) => {
      const a = (uk.match(/\{\w+\}/g) ?? []).sort().join();
      const b = (en.match(/\{\w+\}/g) ?? []).sort().join();
      return a !== b;
    });
    expect(bad).toEqual([]);
  });

  it('translates with placeholders', () => {
    expect(tr('x {n}', { n: 3 }, 'uk')).toBe('x 3');
  });
});
