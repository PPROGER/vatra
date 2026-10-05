// Chat view over the agent's real claude session: history comes from Claude Code's
// transcript, messages are typed into the TUI, so every slash command works.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem, ChatState, Task } from '../../../server/shared/types';
import { CLOSED_STATUSES } from '../../../server/shared/types';
import { api, onServerEvent } from '../api';
import { AssistantText, QuestionCard, splitAttachments, SystemLine, Thinking, ToolGroup, UserBubble, withAttachments, type Delivery } from './ChatItems';
import { Composer, type Attachment, type ComposerHandle } from './Composer';
import { t } from '../i18n';
import { Button, cx } from './ui';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

interface Pending {
  localId: number;
  text: string;
  ts: string;
  status: 'sending' | 'sent' | 'error';
  attachments: string[];
}

const INTERACTIVE = new Set(['/model', '/memory', '/rewind', '/resume', '/permissions', '/agents', '/mcp', '/hooks', '/config', '/output-style', '/export', '/bug', '/plugin', '/login']);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export function Chat({
  task,
  onOpenTerminal,
  toast,
}: {
  task: Task;
  onOpenTerminal: () => void;
  toast: (kind: 'error' | 'info' | 'success', title: string, body?: string) => void;
}) {
  const [state, setState] = useState<ChatState | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const composer = useRef<ComposerHandle>(null);
  const localId = useRef(0);
  const taskId = task.id;
  const scope = useMemo(() => ({ kind: 'task' as const, id: task.id }), [task.id]);

  const load = useCallback(() => {
    api
      .chat(taskId)
      .then(setState)
      .catch(() => setState({ sessionId: null, items: [], context: null, permission: null, activity: null }));
  }, [taskId]);

  useEffect(() => {
    setState(null);
    setPending([]);
    stick.current = true;
    load();
  }, [load]);

  useEffect(
    () =>
      onServerEvent((e) => {
        if (!('taskId' in e) || e.taskId !== taskId) return;
        if (e.type === 'chat') {
          setState((s) => {
            if (!s) return s;
            const items = s.items.slice();
            const idx = new Map(items.map((it, i) => [it.id, i]));
            for (const it of e.items) {
              const i = idx.get(it.id);
              if (i === undefined) {
                idx.set(it.id, items.length);
                items.push(it);
              } else items[i] = it;
            }
            return { ...s, items, context: e.context ?? s.context };
          });
        } else if (e.type === 'chat_reset') {
          load();
        } else if (e.type === 'chat_meta') {
          setState((s) => (s ? { ...s, permission: e.permission, activity: e.activity } : s));
        }
      }),
    [taskId, load],
  );

  // the chat may not have a transcript yet when the agent was just started
  useEffect(() => {
    if (state && !state.sessionId && task.alive) {
      const h = setTimeout(load, 1500);
      return () => clearTimeout(h);
    }
  }, [state, task.alive, task.status, load]);

  // drop pending messages once they show up in the transcript
  useEffect(() => {
    if (!state) return;
    const users = state.items.filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user');
    setPending((ps) =>
      ps.filter((p) => {
        if (p.status !== 'sent') return true;
        const head = norm(p.text).slice(0, 60);
        const isCmd = p.text.startsWith('/');
        const seen = users.some((u) => {
          if (Date.parse(u.ts) < Date.parse(p.ts) - 10_000) return false;
          if (isCmd) return u.command === p.text.split(/\s/)[0];
          return norm(u.text).startsWith(head);
        });
        // commands like /clear never appear in the new transcript
        const stale = isCmd && Date.now() - Date.parse(p.ts) > 8000;
        return !seen && !stale;
      }),
    );
  }, [state]);

  const items = state?.items ?? [];

  // which user messages already got an answer
  const answered = useMemo(() => {
    const set = new Set<string>();
    let sawAnswer = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'assistant' || it.kind === 'tool' || (it.kind === 'system' && it.tone === 'output')) sawAnswer = true;
      else if (it.kind === 'user' && sawAnswer) set.add(it.id);
    }
    return set;
  }, [items]);

  // scroll handling: stay pinned to the bottom unless the user scrolled up
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, state?.permission, state?.activity, task.status]);

  const send = async (text: string, attachments: Attachment[], retryOf?: number) => {
    const id = retryOf ?? ++localId.current;
    const files = attachments.map((a) => a.path);
    const display = withAttachments(text, files);
    stick.current = true;
    setPending((ps) => [...ps.filter((p) => p.localId !== id), { localId: id, text: display, ts: new Date().toISOString(), status: 'sending', attachments: files }]);
    try {
      const r = await api.message(taskId, text, files);
      setPending((ps) => ps.map((p) => (p.localId === id ? { ...p, status: 'sent' } : p)));
      const cmd = text.split(/\s/)[0];
      if (INTERACTIVE.has(cmd) && !(cmd === '/model' && text.trim() !== '/model')) {
        toast('info', t('{cmd} відкриває меню в терміналі', { cmd }), t('Перемикаю на термінал — відповідай там.'));
        setTimeout(onOpenTerminal, 400);
      }
      if (r.delivered === 'relaunch') toast('info', t('Агент перезапускається з --resume'), t('Повідомлення буде першим запитом нової сесії'));
    } catch (e) {
      setPending((ps) => ps.map((p) => (p.localId === id ? { ...p, status: 'error' } : p)));
      toast('error', t('Не надіслано'), (e as Error).message);
    }
  };

  const key = (k: string) => api.keys(taskId, k).catch((e) => toast('error', t('Не вдалося'), e.message));

  const live = task.status === 'running' || task.status === 'idle';
  const closed = CLOSED_STATUSES.includes(task.status);
  const ctx = state?.context;
  const pct = ctx ? Math.min(100, Math.round((ctx.usedTokens / ctx.windowTokens) * 100)) : 0;

  // group consecutive tool calls into one card
  const blocks: ({ type: 'item'; item: ChatItem } | { type: 'tools'; items: ToolItem[] })[] = [];
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === 'tool' && it.name === 'AskUserQuestion') blocks.push({ type: 'item', item: it });
    else if (it.kind === 'tool' && last?.type === 'tools') last.items.push(it);
    else if (it.kind === 'tool') blocks.push({ type: 'tools', items: [it] });
    else blocks.push({ type: 'item', item: it });
  }

  return (
    <div
      className="@container relative flex h-full flex-col bg-bg"
      onDragOver={(e) => {
        if (closed || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!closed) composer.current?.addFiles([...e.dataTransfer.files]);
      }}
    >
      {/* top bar: model, context, quick actions */}
      <div className="flex items-center gap-3 px-4 h-10 border-b border-line shrink-0 text-[12px]">
        <span className="text-muted font-mono truncate max-w-48" title={t('Модель')}>
          {ctx?.model?.replace(/^claude-/, '') ?? '—'}
        </span>
        <div className="flex items-center gap-2" title={ctx ? t('{used} з {total} токенів', { used: ctx.usedTokens.toLocaleString(), total: ctx.windowTokens.toLocaleString() }) : t('Ще немає даних')}>
          <div className="w-28 h-1.5 rounded-full bg-panel-2 overflow-hidden">
            <div className={cx('h-full rounded-full', pct < 60 ? 'bg-emerald-500' : pct < 85 ? 'bg-amber-400' : 'bg-red-500')} style={{ width: `${pct}%` }} />
          </div>
          <span className="text-muted font-mono whitespace-nowrap">
            {ctx ? `${fmtTokens(ctx.usedTokens)} / ${fmtTokens(ctx.windowTokens)}` : t('контекст')}
            {ctx && <span className="hidden @2xl:inline"> · {t('вільно {pct}%', { pct: 100 - pct })}</span>}
          </span>
        </div>
        {!closed && (
          <div className="ml-auto flex items-center gap-1">
            {[
              ['/compact', t('Стиснути контекст')],
              ['/context', t('Що займає контекст')],
              ['/cost', t('Вартість/токени')],
            ].map(([c, title]) => (
              <button
                key={c}
                className={cx('h-6 px-2 rounded-md font-mono text-[11.5px] text-muted hover:text-fg hover:bg-panel-2 cursor-pointer', c !== '/compact' && 'hidden @3xl:inline-block')}
                title={title}
                onClick={() => send(c, [])}
              >
                {c}
              </button>
            ))}
            <button
              className="hidden @3xl:inline-block h-6 px-2 rounded-md font-mono text-[11.5px] text-muted hover:text-fg hover:bg-panel-2 cursor-pointer"
              title={t('Почати розмову заново (історія агента скидається)')}
              onClick={() => confirm(t('Очистити розмову агента (/clear)? Зміни в коді лишаться.')) && send('/clear', [])}
            >
              /clear
            </button>
            {live && (
              <button className="h-6 px-2 rounded-md text-[11.5px] text-muted hover:text-fg hover:bg-panel-2 cursor-pointer whitespace-nowrap" title={t('Shift+Tab у claude: звичайний → auto-accept → plan')} onClick={() => key('mode')}>
                {t('⇧Tab режим')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* messages */}
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto max-w-4xl px-5 py-5 space-y-3.5">
          {state === null && <div className="text-center text-faint text-[12px] py-10">{t('Завантажую розмову…')}</div>}
          {state && items.length === 0 && pending.length === 0 && !task.prompt && (
            <div className="text-center text-faint text-[12.5px] py-12">
              {task.status === 'creating' || task.status === 'queued'
                ? t('Агент ще стартує…')
                : live
                  ? t('Розмова порожня. Напиши агенту, що зробити, або обери /команду.')
                  : t('Немає історії розмови для цієї задачі.')}
            </div>
          )}
          {/* the first prompt, until claude's transcript shows it */}
          {state && task.prompt && !items.some((i) => i.kind === 'user') && (
            <UserBubble taskId={taskId} text={task.prompt} ts={task.createdAt} delivery={task.status === 'creating' || task.status === 'queued' ? 'sending' : 'sent'} />
          )}
          {state && items.length === 0 && !state.permission && ['creating', 'queued', 'running'].includes(task.status) && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span className="size-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              {task.status === 'creating' ? t('Готую worktree і гілку…') : task.status === 'queued' ? t('Чекаю вільного слота для агента…') : t('Запускаю claude…')}
            </div>
          )}
          {blocks.map((b, i) =>
            b.type === 'tools' ? (
              <ToolGroup key={b.items[0].id} items={b.items} root={task.worktreePath} />
            ) : b.item.kind === 'user' ? (
              <UserBubble key={b.item.id} taskId={taskId} text={b.item.text} ts={b.item.ts} command={b.item.command} bash={b.item.bash} delivery={answered.has(b.item.id) ? 'answered' : 'delivered'} />
            ) : b.item.kind === 'assistant' ? (
              <AssistantText key={b.item.id} text={b.item.text} />
            ) : b.item.kind === 'thinking' ? (
              <Thinking key={b.item.id} text={b.item.text} />
            ) : b.item.kind === 'tool' ? (
              <QuestionCard
                key={b.item.id}
                item={b.item}
                live={live}
                onAnswer={(answers) =>
                  api
                    .answer(taskId, b.item.id, answers)
                    .then(() => true)
                    .catch((e) => {
                      toast('error', t('Не вдалося'), (e as Error).message);
                      return false;
                    })
                }
              />
            ) : b.item.kind === 'system' ? (
              <SystemLine key={b.item.id ?? i} text={b.item.text} tone={b.item.tone} />
            ) : null,
          )}
          {pending.map((p) => (
            <UserBubble
              key={'p' + p.localId}
              taskId={taskId}
              text={p.text}
              ts={p.ts}
              command={p.text.startsWith('/') ? p.text.split(/\s/)[0] : undefined}
              bash={p.text.startsWith('!')}
              delivery={p.status as Delivery}
              onRetry={() => {
                void send(splitAttachments(p.text).body, p.attachments.map((path) => ({ path, name: path })), p.localId);
              }}
            />
          ))}
          {task.status === 'running' && !state?.permission && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span className="flex gap-0.5">
                <span className="size-1.5 rounded-full bg-accent pulse-dot" />
                <span className="size-1.5 rounded-full bg-accent pulse-dot [animation-delay:0.2s]" />
                <span className="size-1.5 rounded-full bg-accent pulse-dot [animation-delay:0.4s]" />
              </span>
              <span className="truncate font-mono">{state?.activity ?? t('Працює…')}</span>
              <button className="ml-2 text-faint hover:text-red-300 cursor-pointer" onClick={() => key('interrupt')} title={t('Esc у claude — перервати поточний хід')}>
                {t('перервати')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* permission request */}
      {state?.permission && live && (
        <div className="mx-auto w-full max-w-4xl px-5 pb-2">
          <div className="rounded-xl border border-amber-700/60 bg-amber-950/25 px-4 py-3">
            <div className="text-[12px] text-amber-300 font-medium mb-0.5">{state.permission.kind === 'trust' ? t('Довіряти папці?') : t('Агент просить дозвіл')}</div>
            {state.permission.tool && <div className="font-mono text-[12.5px] text-fg break-all mb-0.5">{state.permission.tool}</div>}
            <div className="text-[12px] text-muted mb-2.5">{state.permission.message}</div>
            <div className="flex flex-wrap gap-1.5">
              {state.permission.kind === 'trust' ? (
                <>
                  <Button variant="primary" onClick={() => key('allow')}>
                    {t('Довіряю, працюй')}
                  </Button>
                  <Button variant="danger" onClick={() => key('deny')}>
                    {t('Ні')}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="primary" onClick={() => key('allow')}>
                    {t('Дозволити')}
                  </Button>
                  <Button onClick={() => key('allow-always')} title={t('«Yes, and don\'t ask again» — друга опція в меню claude')}>
                    {t('Дозволити й не питати')}
                  </Button>
                  <Button variant="danger" onClick={() => key('deny')} title={t('Esc — відмовити і сказати, що робити інакше')}>
                    {t('Відхилити')}
                  </Button>
                </>
              )}
              <Button variant="ghost" onClick={onOpenTerminal}>
                {t('Показати в терміналі')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* composer */}
      {!closed && (
        <div className="mx-auto w-full max-w-4xl px-5 pb-4">
          {!live && task.status !== 'creating' && (
            <div className="text-[11.5px] text-faint mb-1.5">
              {task.status === 'queued'
                ? t('Агент у черзі — повідомлення дочекається запуску.')
                : task.status === 'sleeping'
                  ? t('Агент спить — повідомлення розбудить його з тієї ж розмови (--resume).')
                  : t('Агент не запущений — повідомлення перезапустить його з --resume.')}
            </div>
          )}
          <Composer
            ref={composer}
            scope={scope}
            disabled={task.status === 'creating'}
            placeholder={live ? t('Напиши агенту… ( / — команди, @ — файли, ! — bash )') : t('Повідомлення перезапустить агента…')}
            onSend={(t, a) => void send(t, a)}
            onError={(m) => toast('error', t('Помилка'), m)}
          />
        </div>
      )}

      {dragging && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-bg/80 border-2 border-dashed border-accent/60 rounded-lg pointer-events-none">
          <div className="text-accent text-[14px]">{t('Відпусти, щоб прикріпити файли')}</div>
        </div>
      )}
    </div>
  );
}
