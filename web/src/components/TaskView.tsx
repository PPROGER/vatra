import { useEffect, useState } from 'react';
import type { Project, Task } from '../../../server/shared/types';
import { OPEN_STATUSES } from '../../../server/shared/types';
import { api } from '../api';
import { DiffView } from './DiffView';
import { Terminal } from './Terminal';
import { Chat } from './Chat';
import { Button, cx, Menu, StatusBadge, timeAgo } from './ui';

type Tab = 'chat' | 'terminal' | 'diff' | 'split';

export function TaskView({
  task,
  project,
  diffTick,
  toast,
}: {
  task: Task;
  project: Project | undefined;
  diffTick: number;
  toast: (kind: 'error' | 'info' | 'success', title: string, body?: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('vatra-tab') as Tab) || 'chat';
    } catch {
      return 'chat';
    }
  });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('vatra-tab', tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  const open = OPEN_STATUSES.includes(task.status) && task.status !== 'creating';
  const live = task.status === 'running' || task.status === 'idle';
  const canMerge = ['idle', 'review', 'error', 'queued'].includes(task.status);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast('success', ok);
    } catch (e) {
      toast('error', 'Не вдалося', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const merge = (strategy: 'merge' | 'squash', push = false) => {
    if (push && !confirm(`Злити ${task.branch} у ${task.baseBranch} і запушити ${task.baseBranch} в origin?`)) return;
    return act('merge', async () => {
      const r = await api.merge(task.id, strategy, push);
      if (r.conflict) toast('error', 'Конфлікт злиття', `${r.conflict.join(', ')}\nАгенту відправлено прохання зробити rebase.`);
      else toast(r.message.includes('push не пройшов') ? 'error' : 'success', r.message);
    });
  };

  const mergeItems = [
    { label: 'Злити й запушити', hint: `merge у ${task.baseBranch} + git push origin ${task.baseBranch}`, onClick: () => merge('merge', true) },
    { label: 'Squash і запушити', hint: `один коміт у ${task.baseBranch} + push`, onClick: () => merge('squash', true) },
    { label: 'Злити локально', hint: `git merge --no-ff, без push`, onClick: () => merge('merge') },
    { label: 'Squash локально', hint: 'один коміт, без push', onClick: () => merge('squash') },
  ];

  const discard = () => {
    if (!confirm(`Відкинути «${task.title}»? Worktree і гілку ${task.branch} буде видалено без можливості відновлення.`)) return;
    void act('discard', () => api.discard(task.id), 'Задачу відкинуто');
  };

  const prMode = project?.mergeMode !== 'merge';
  const prOpen = !!task.prUrl && task.prState === 'OPEN';
  const prNumber = task.prUrl?.match(/\/pull\/(\d+)/)?.[1];

  const pr = () =>
    act('pr', async () => {
      const r = await api.pr(task.id);
      if (r.manual) {
        toast('info', 'Гілку запушено', r.url ? 'GitHub CLI (gh) не встановлено — відкриваю сторінку створення PR на GitHub' : r.output);
        if (r.url) window.open(r.url, '_blank', 'noopener');
      } else if (r.created) {
        toast('success', 'PR створено', r.url ?? r.output);
        if (r.url) window.open(r.url, '_blank', 'noopener');
      } else toast('success', 'PR оновлено', 'Нові коміти агента запушено в той самий PR');
    });

  const prCheck = () =>
    act('prcheck', async () => {
      const t = await api.prCheck(task.id);
      if (t.status === 'merged') toast('success', 'PR злито — задачу закрито');
      else toast('info', `PR: ${t.prState === 'OPEN' ? 'відкритий, ще не злитий' : t.prState === 'CLOSED' ? 'закритий без злиття' : t.prState}`);
    });

  const showChat = tab === 'chat' || tab === 'split';
  const showTerm = tab === 'terminal';
  const showDiff = tab === 'diff' || tab === 'split';

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* header */}
      <div className="flex items-start gap-4 px-5 pt-3.5 pb-3 border-b border-line shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <EditableTitle task={task} onError={(m) => toast('error', 'Не вдалося перейменувати', m)} />
            <StatusBadge status={task.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted font-mono">
            <span title="Гілка агента">{task.branch}</span>
            <span className="text-faint">← {task.baseBranch}{task.baseCommit ? `@${task.baseCommit.slice(0, 7)}` : ''}</span>
            {task.port && <span className="text-faint">PORT={task.port}</span>}
            <span className="text-faint font-sans">{project?.name} · {timeAgo(task.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
          {open && (
            <Menu
              label="Відкрити"
              items={[
                { label: 'Zed', onClick: () => act('open', () => api.open(task.id, 'zed')) },
                { label: 'Файли', hint: 'Finder / файловий менеджер', onClick: () => act('open', () => api.open(task.id, 'files')) },
                { label: 'Термінал', onClick: () => act('open', () => api.open(task.id, 'terminal')) },
              ]}
            />
          )}
          {live && (
            <Button busy={busy === 'stop'} onClick={() => act('stop', () => api.stop(task.id))} title="Зупинити claude (SIGTERM, через 5 с SIGKILL)">
              Зупинити
            </Button>
          )}
          {open && (
            <Button busy={busy === 'restart'} onClick={() => act('restart', () => api.restart(task.id))} title="Нова сесія з claude --resume">
              {live ? 'Перезапустити' : 'Запустити'}
            </Button>
          )}
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className={cx(
                'inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-[12px] font-mono',
                task.prState === 'MERGED' ? 'border-violet-800 text-violet-300' : task.prState === 'CLOSED' ? 'border-line-2 text-faint line-through' : 'border-emerald-800 text-emerald-300',
              )}
              title="Відкрити PR на GitHub"
            >
              PR #{prNumber ?? '?'} ↗
            </a>
          )}
          {open && prOpen && (
            <Button busy={busy === 'prcheck'} onClick={prCheck} title="Перевірити, чи PR уже злили (Ватра й так перевіряє кожні 2 хв)">
              ↻
            </Button>
          )}
          {open && prMode && (
            <Button
              variant="primary"
              busy={busy === 'pr'}
              disabled={!canMerge}
              onClick={pr}
              title={prOpen ? 'Закомітити й запушити нові зміни агента в цей PR' : `git push + gh pr create → ${task.baseBranch}`}
            >
              {prOpen ? 'Оновити PR' : 'Створити PR'}
            </Button>
          )}
          {open && !prMode && (
            <Button busy={busy === 'pr'} disabled={!canMerge} onClick={pr} title="git push + gh pr create">
              {prOpen ? 'Оновити PR' : 'PR'}
            </Button>
          )}
          {open && (
            <Menu
              label={busy === 'merge' ? 'Зливаю…' : 'Злити'}
              variant={prMode ? 'default' : 'primary'}
              disabled={!canMerge || busy === 'merge'}
              items={mergeItems}
            />
          )}
          {(open || task.status === 'creating') && (
            <Button variant="danger" busy={busy === 'discard'} onClick={discard}>
              Відкинути
            </Button>
          )}
        </div>
      </div>

      {(task.statusReason || task.lastMessage) && (
        <div
          className={cx(
            'px-5 py-2 text-[12px] border-b border-line',
            task.status === 'error' ? 'bg-red-950/30 text-red-300' : task.lastMessage ? 'bg-amber-950/20 text-amber-200' : 'bg-violet-950/20 text-violet-200',
          )}
        >
          {task.lastMessage ?? task.statusReason}
        </div>
      )}

      {/* tabs + message */}
      <div className="flex items-center gap-3 px-3 h-10 border-b border-line shrink-0">
        <div className="flex">
          {(
            [
              ['chat', 'Чат'],
              ['terminal', 'Термінал'],
              ['diff', 'Диф'],
              ['split', 'Чат + диф'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cx(
                'px-3 h-10 text-[12px] border-b-2 -mb-px cursor-pointer',
                tab === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-faint pr-2">
          {tab === 'terminal' ? 'Сирий TUI claude — для меню, /model, /config тощо' : task.alive ? 'Чат і термінал — одна й та сама сесія claude' : ''}
        </span>
      </div>

      {/* body */}
      <div className={cx('flex-1 min-h-0', tab === 'split' ? 'grid grid-cols-2 divide-x divide-line' : 'flex')}>
        <div className={cx('min-w-0 min-h-0 h-full', showChat ? 'flex-1' : 'hidden')}>
          <Chat task={task} onOpenTerminal={() => setTab('terminal')} toast={toast} />
        </div>
        <div className={cx('min-w-0 min-h-0 h-full', showTerm ? 'flex-1' : 'hidden')}>
          {task.alive ? (
            <Terminal key={task.id} taskId={task.id} alive={!!task.alive} />
          ) : (
            <NotRunning task={task} onStart={() => act('restart', () => api.restart(task.id))} busy={busy === 'restart'} canStart={open} />
          )}
        </div>
        <div className={cx('min-w-0 min-h-0 h-full', showDiff ? 'flex-1' : 'hidden')}>
          {task.status === 'merged' || task.status === 'discarded' ? (
            <div className="h-full grid place-items-center text-muted">Worktree прибрано — дифу більше немає.</div>
          ) : (
            <DiffView taskId={task.id} refreshKey={diffTick} enabled={showDiff && !!task.baseCommit} />
          )}
        </div>
      </div>
    </div>
  );
}

function EditableTitle({ task, onError }: { task: Task; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const save = async () => {
    setEditing(false);
    if (value.trim() && value.trim() !== task.title) {
      try {
        await api.renameTask(task.id, value.trim());
      } catch (e) {
        onError((e as Error).message);
        setValue(task.title);
      }
    } else setValue(task.title);
  };
  if (editing)
    return (
      <input
        autoFocus
        className="text-[15px] font-semibold bg-bg border border-accent/50 rounded-md px-1.5 -mx-1.5 outline-none min-w-0 w-[min(560px,100%)]"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') (setValue(task.title), setEditing(false));
        }}
      />
    );
  return (
    <h1 className="text-[15px] font-semibold truncate cursor-text hover:text-accent/90" title="Клікни, щоб перейменувати" onClick={() => (setValue(task.title), setEditing(true))}>
      {task.title}
    </h1>
  );
}

function NotRunning({ task, onStart, busy, canStart }: { task: Task; onStart: () => void; busy: boolean; canStart: boolean }) {
  const text: Record<string, string> = {
    creating: 'Створюю worktree і готую середовище…',
    queued: 'Чекає вільного слота (ліміт активних агентів).',
    review: 'Агент не запущений. Переглянь диф, злий або продовж роботу.',
    error: 'Агент не запущений.',
    merged: `Злито${task.mergedAt ? ` ${timeAgo(task.mergedAt)} тому` : ''}. Worktree і гілку прибрано.`,
    discarded: 'Задачу відкинуто.',
    running: 'Підключаюсь…',
    idle: 'Підключаюсь…',
  };
  return (
    <div className="h-full grid place-items-center bg-bg">
      <div className="text-center max-w-sm">
        <div className="text-muted text-[13px] mb-3">{text[task.status]}</div>
        {canStart && task.status !== 'queued' && (
          <Button variant="primary" onClick={onStart} busy={busy}>
            Запустити агента (--resume)
          </Button>
        )}
      </div>
    </div>
  );
}
