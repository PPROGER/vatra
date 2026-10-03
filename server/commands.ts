// Slash commands offered in the chat composer. Everything is typed into the real
// claude TUI, so any command works — this list only powers autocomplete.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { SlashCommand } from './shared/types.js';

// `interactive` = opens a picker/dialog in the TUI that has to be answered in the terminal.
const BUILTIN: [string, string, boolean?, string?][] = [
  ['/compact', 'Стиснути розмову, звільнити контекст', false, '[інструкції]'],
  ['/clear', 'Почати розмову з чистого аркуша'],
  ['/context', 'Показати, чим зайнятий контекст'],
  ['/cost', 'Вартість і токени цієї сесії'],
  ['/usage', 'Ліміти підписки'],
  ['/model', 'Змінити модель', true, '[назва]'],
  ['/init', 'Створити CLAUDE.md для репозиторію'],
  ['/review', 'Код-ревʼю змін'],
  ['/security-review', 'Перевірка безпеки змін у гілці'],
  ['/memory', 'Редагувати CLAUDE.md памʼять', true],
  ['/rewind', 'Відкотити розмову/код до попередньої точки', true],
  ['/resume', 'Відновити іншу розмову', true],
  ['/todos', 'Поточний список задач агента'],
  ['/status', 'Версія, модель, акаунт'],
  ['/permissions', 'Правила дозволів', true],
  ['/agents', 'Керування субагентами', true],
  ['/mcp', 'MCP сервери', true],
  ['/hooks', 'Налаштування хуків', true],
  ['/config', 'Налаштування Claude Code', true],
  ['/output-style', 'Стиль відповідей', true],
  ['/add-dir', 'Додати ще одну робочу папку', false, '<шлях>'],
  ['/export', 'Експорт розмови', true],
  ['/doctor', 'Діагностика встановлення'],
  ['/help', 'Довідка'],
  ['/bug', 'Надіслати баг-репорт', true],
  ['/release-notes', 'Що нового'],
  ['/plugin', 'Плагіни', true],
  ['/login', 'Увійти', true],
  ['/logout', 'Вийти'],
  ['/vim', 'Vim-режим вводу'],
  ['/exit', 'Завершити claude (задача перейде в ревʼю)'],
];

function frontmatter(file: string): Record<string, string> {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 4000);
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const out: Record<string, string> = {};
    if (m) {
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^([\w-]+):\s*(.*)$/);
        if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
      }
    }
    if (!out.description) {
      const body = (m ? text.slice(m[0].length) : text).split('\n').find((l) => l.trim() && !l.startsWith('#'));
      if (body) out.description = body.trim().slice(0, 120);
    }
    return out;
  } catch {
    return {};
  }
}

function walkMd(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 3) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) out.push(...walkMd(p, depth + 1));
      else if (n.endsWith('.md')) out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
}

function customCommands(dir: string, source: 'project' | 'user'): SlashCommand[] {
  return walkMd(dir).map((file) => {
    const fm = frontmatter(file);
    const rel = relative(dir, file).replace(/\.md$/, '');
    const name = '/' + rel.split('/').join(':');
    return { name, description: fm.description || (source === 'project' ? 'Команда проєкту' : 'Твоя команда'), source, args: fm['argument-hint'] };
  });
}

function skills(dir: string): SlashCommand[] {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  for (const n of readdirSync(dir)) {
    const file = join(dir, n, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(file);
    out.push({ name: '/' + (fm.name || basename(n)), description: fm.description?.slice(0, 160) || 'Skill', source: 'skill' });
  }
  return out;
}

export function listSlashCommands(worktree: string): SlashCommand[] {
  const home = homedir();
  const all: SlashCommand[] = [
    ...customCommands(join(worktree, '.claude', 'commands'), 'project'),
    ...skills(join(worktree, '.claude', 'skills')),
    ...customCommands(join(home, '.claude', 'commands'), 'user'),
    ...skills(join(home, '.claude', 'skills')),
    ...BUILTIN.map(([name, description, interactive, args]) => ({ name, description, source: 'builtin' as const, interactive: !!interactive, args })),
  ];
  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

/** Commands that need the terminal when called without arguments. */
export function isInteractive(text: string): boolean {
  const [name, ...rest] = text.trim().split(/\s+/);
  const b = BUILTIN.find((x) => x[0] === name);
  if (!b?.[2]) return false;
  return name === '/model' ? rest.length === 0 : true;
}
