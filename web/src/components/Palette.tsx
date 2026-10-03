// ⌘K / Ctrl+K: jump to any task (open or archived) or start a new one.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Task } from '../../../server/shared/types';
import { CLOSED_STATUSES } from '../../../server/shared/types';
import { t, tk } from '../i18n';
import { cx, StatusDot } from './ui';

type Item = { key: string; kind: 'task'; task: Task; project?: Project; hay: string } | { key: string; kind: 'new'; project: Project; hay: string };

function score(hay: string, q: string): number {
  if (!q) return 1;
  const i = hay.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 80 - Math.min(i, 60) / 2;
  // subsequence
  let j = 0;
  for (const ch of hay) if (ch === q[j]) j++;
  return j === q.length ? 10 : 0;
}

export function Palette({
  projects,
  tasks,
  onClose,
  onTask,
  onNew,
}: {
  projects: Project[];
  tasks: Task[];
  onClose: () => void;
  onTask: (id: number) => void;
  onNew: (projectId: number) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all: Item[] = [
      ...projects.map((p) => ({ key: `new-${p.id}`, kind: 'new' as const, project: p, hay: `${tk('нова задача')} new task ${p.name}`.toLowerCase() })),
      ...tasks.map((task) => {
        const project = projects.find((p) => p.id === task.projectId);
        return { key: `t-${task.id}`, kind: 'task' as const, task, project, hay: `${task.title} ${task.branch} ${project?.name ?? ''} #${task.id}`.toLowerCase() };
      }),
    ];
    const ranked = all
      .map((it) => {
        let s = score(it.hay, query);
        if (it.kind === 'task' && CLOSED_STATUSES.includes(it.task.status)) s -= 5; // archive after open tasks
        if (it.kind === 'new' && !query) s = 0.5; // without a query: tasks first
        return { it, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (a.it.kind === 'task' && b.it.kind === 'task' ? b.it.task.id - a.it.task.id : 0));
    return ranked.slice(0, 50).map((x) => x.it);
  }, [q, projects, tasks]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    if (it.kind === 'task') onTask(it.task.id);
    else onNew(it.project.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-[2px] p-4 pt-[14vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-line-2 bg-panel shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, items.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            else if (e.key === 'Enter') (e.preventDefault(), choose(items[sel]));
          }}
          placeholder={t('Знайти задачу, гілку, проєкт… або «нова»')}
          className="w-full bg-transparent px-4 h-12 text-[14px] outline-none border-b border-line placeholder:text-faint"
        />
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1">
          {items.length === 0 && <div className="px-3 py-6 text-center text-faint text-[12.5px]">{t('Нічого не знайдено')}</div>}
          {items.map((it, i) => (
            <button
              key={it.key}
              data-i={i}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(it)}
              className={cx('w-full flex items-center gap-2.5 text-left rounded-md px-3 py-2 cursor-pointer', i === sel && 'bg-[#232933]')}
            >
              {it.kind === 'task' ? (
                <>
                  <StatusDot status={it.task.status} />
                  <span className={cx('truncate text-[13px]', CLOSED_STATUSES.includes(it.task.status) ? 'text-faint' : 'text-fg')}>{it.task.title}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-faint font-mono truncate max-w-48">
                    {it.project?.name} · {it.task.branch}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-accent text-[15px] leading-none w-2 text-center">+</span>
                  <span className="text-[13px]">{t('Нова задача')}</span>
                  <span className="ml-auto text-[11px] text-faint">{it.project.name}</span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="flex gap-3 px-3 h-8 items-center border-t border-line text-[11px] text-faint">
          <span>↑↓ {t('вибрати')}</span>
          <span>↵ {t('відкрити')}</span>
          <span>Esc {t('закрити')}</span>
          <span className="ml-auto">Alt+↑/↓ — {t('сусідня задача')}</span>
        </div>
      </div>
    </div>
  );
}
