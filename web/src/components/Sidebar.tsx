import { useState } from 'react';
import type { Project, ServerInfo, Task } from '../../../server/shared/types';
import { CLOSED_STATUSES } from '../../../server/shared/types';
import { t } from '../i18n';
import { cx, StatusDot, timeAgo } from './ui';

export function Sidebar({
  projects,
  tasks,
  selected,
  info,
  connected,
  onSelect,
  onNewProject,
  onNewTask,
  onProjectSettings,
  drafting,
  onSettings,
  onPalette,
}: {
  projects: Project[];
  tasks: Task[];
  selected: number | null;
  info: ServerInfo | null;
  connected: boolean;
  onSelect: (id: number) => void;
  onNewProject: () => void;
  onNewTask: (p: Project) => void;
  onProjectSettings: (p: Project) => void;
  /** Project whose "new task" chat is open, if any. */
  drafting: number | null;
  onSettings: () => void;
  onPalette: () => void;
}) {
  // which projects have their archive expanded (remembered per browser)
  const [openArchives, setOpenArchives] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('vatra-open-archives') ?? '[]') as number[]);
    } catch {
      return new Set();
    }
  });
  const [archiveLimit, setArchiveLimit] = useState<Record<number, number>>({});
  const toggleArchive = (id: number) =>
    setOpenArchives((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem('vatra-open-archives', JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });
  const live = tasks.filter((t) => t.status === 'running' || t.status === 'idle').length;
  const waiting = tasks.filter((t) => t.status === 'idle').length;
  const [notifPerm, setNotifPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  const renderTask = (t: Task) => (
    <button
      key={t.id}
      onClick={() => onSelect(t.id)}
      className={cx(
        'w-full text-left flex items-start gap-2.5 px-3 py-1.5 mx-0 border-l-2 cursor-pointer',
        selected === t.id ? 'bg-panel-2 border-accent' : 'border-transparent hover:bg-[#151920]',
      )}
    >
      <span className="pt-[5px]">
        <StatusDot status={t.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={cx('truncate text-[13px]', CLOSED_STATUSES.includes(t.status) ? 'text-faint' : 'text-fg')}>{t.title}</span>
          {t.prUrl && t.prState === 'OPEN' && (
            <span className="shrink-0 text-[9.5px] font-mono rounded border border-emerald-800 text-emerald-400 px-1 leading-[14px]">PR</span>
          )}
        </span>
        <span className="block truncate text-[11px] text-faint font-mono">
          {t.status === 'idle' && t.lastMessage ? <span className="text-amber-300/80 font-sans">{t.lastMessage}</span> : `${t.slug} · ${timeAgo(t.createdAt)}`}
        </span>
      </span>
    </button>
  );

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 2.5c.6 3.2-1.4 4.9-2.9 6.6C7.6 10.8 6.5 12.6 6.5 15a5.5 5.5 0 0 0 11 0c0-2.1-.9-3.7-2-5 .1 1.6-.5 2.8-1.6 3.4.4-3.5-.6-7.6-1.9-10.9Z"
            fill="#f97316"
          />
          <path d="M12 21a2.9 2.9 0 0 1-2.9-2.9c0-1.6 1.1-2.6 2-3.6.3 1 .9 1.6 1.7 1.9.2-.9.6-1.6 1.2-2.2.6.9 1 1.9 1 3A2.9 2.9 0 0 1 12 21Z" fill="#fde68a" />
        </svg>
        <span className="font-semibold tracking-tight">{t('Ватра')}</span>
        <span
          className={cx(
            'ml-auto text-[11px] font-mono px-1.5 h-5 inline-flex items-center rounded',
            live >= (info?.maxActive ?? 99) ? 'bg-amber-950/50 text-amber-300' : 'bg-panel-2 text-muted',
          )}
          title={t('Активні агенти / ліміт')}
        >
          {live}/{info?.maxActive ?? '–'}
        </span>
        <span
          className={cx('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-500 pulse-dot')}
          title={connected ? t('Підключено') : t('Немає звʼязку з сервером')}
        />
      </div>

      {projects.length > 0 && (
        <div className="px-3 pt-3">
          <button
            onClick={() => {
              const sel = tasks.find((t) => t.id === selected);
              const p = projects.find((x) => x.id === (sel?.projectId ?? drafting)) ?? projects[0];
              onNewTask(p);
            }}
            className={cx(
              'w-full h-8 rounded-lg border text-[12.5px] font-medium cursor-pointer flex items-center justify-center gap-1.5',
              drafting !== null && selected === null
                ? 'border-accent/60 bg-accent/10 text-fg'
                : 'border-line-2 text-muted hover:text-fg hover:border-accent/50',
            )}
          >
            <span className="text-accent text-[15px] leading-none">+</span> {t('Нова задача')}
          </button>
          <button
            onClick={onPalette}
            className="mt-1.5 w-full h-7 rounded-md text-[12px] text-faint hover:text-muted hover:bg-panel-2 cursor-pointer flex items-center justify-between px-2.5"
            title={t('Пошук по задачах і архіву')}
          >
            <span>⌕ {t('Пошук')}</span>
            <span className="font-mono text-[10.5px] border border-line-2 rounded px-1">{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</span>
          </button>
        </div>
      )}

      {waiting > 0 && (
        <div className="px-4 py-1.5 text-[11px] text-amber-300 bg-amber-950/20 border-b border-line">{t('Агентів чекає на тебе: {n}', { n: waiting })}</div>
      )}

      <nav className="flex-1 overflow-y-auto py-2">
        {projects.map((p) => {
          const pt = tasks.filter((t) => t.projectId === p.id);
          const visible = pt.filter((t) => !CLOSED_STATUSES.includes(t.status));
          const archived = pt.filter((t) => CLOSED_STATUSES.includes(t.status)).sort((a, b) => b.id - a.id);
          // a selected archived task keeps its project's archive open
          const archiveOpen = openArchives.has(p.id) || archived.some((t) => t.id === selected);
          const limit = archiveLimit[p.id] ?? 15;
          const shownArchive = archiveOpen ? archived.slice(0, Math.max(limit, archived.findIndex((t) => t.id === selected) + 1)) : [];
          return (
            <div key={p.id} className="mb-3">
              <div className="group flex items-center gap-1 px-3 h-7">
                <span className="text-[11px] uppercase tracking-wider text-faint font-medium truncate" title={p.repoPath}>
                  {p.name}
                </span>
                <span className="text-[11px] text-faint font-mono">· {p.defaultBranch}</span>
                <button
                  className="ml-auto opacity-0 group-hover:opacity-100 text-faint hover:text-fg px-1 cursor-pointer"
                  onClick={() => onProjectSettings(p)}
                  title={t('Налаштування проєкту')}
                >
                  ⚙
                </button>
                <button
                  className={cx(
                    'px-1 text-[15px] leading-none cursor-pointer',
                    drafting === p.id && selected === null ? 'text-accent' : 'text-muted hover:text-accent',
                  )}
                  onClick={() => onNewTask(p)}
                  title={t('Нова задача в цьому проєкті')}
                >
                  +
                </button>
              </div>
              {visible.map((t) => renderTask(t))}
              {visible.length === 0 && (
                <button className="block px-3 py-1 text-[12px] text-faint hover:text-muted cursor-pointer" onClick={() => onNewTask(p)}>
                  {t('Немає відкритих задач — створити')}
                </button>
              )}
              {archived.length > 0 && (
                <div className="mt-0.5">
                  <button
                    className="flex w-full items-center gap-1.5 px-3 h-6 text-[11px] text-faint hover:text-muted cursor-pointer"
                    onClick={() => toggleArchive(p.id)}
                    title={archiveOpen ? t('Сховати архів') : t('Показати архів цього проєкту')}
                  >
                    <span className={cx('inline-block w-2.5 transition-transform', archiveOpen && 'rotate-90')}>▸</span>
                    🗄 {t('Архів')} · {archived.length}
                  </button>
                  {archiveOpen && (
                    <div className="ml-3 border-l border-line">
                      {shownArchive.map((t) => renderTask(t))}
                      {archived.length > shownArchive.length && (
                        <button
                          className="block px-3 py-1 text-[11px] text-faint hover:text-muted cursor-pointer"
                          onClick={() =>
                            setArchiveLimit((l) => ({
                              ...l,
                              [p.id]: limit + 30,
                            }))
                          }
                        >
                          {t('Показати ще {n}', {
                            n: Math.min(30, archived.length - shownArchive.length),
                          })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-line p-3 space-y-2">
        {info?.warnings.map((w) => (
          <div key={w} className="text-[11px] text-amber-300/90 leading-snug">
            ! {w}
          </div>
        ))}
        {notifPerm === 'default' && (
          <button
            className="w-full text-left text-[11px] text-muted hover:text-fg cursor-pointer"
            onClick={() => Notification.requestPermission().then(setNotifPerm)}
          >
            🔔 {t('Увімкнути сповіщення браузера')}
          </button>
        )}
        <button onClick={onSettings} className="w-full text-left text-[11px] text-muted hover:text-fg cursor-pointer">
          ⚙ {t('Налаштування')}
        </button>
        <button
          onClick={onNewProject}
          className="w-full h-8 rounded-md border border-dashed border-line-2 text-[12px] text-muted hover:text-fg hover:border-[#3a4150] cursor-pointer"
        >
          + {t('Додати проєкт')}
        </button>
      </div>
    </aside>
  );
}
