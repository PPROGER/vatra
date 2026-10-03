import { html as diffHtml } from 'diff2html';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffMode, DiffResult } from '../../../server/shared/types';
import { api } from '../api';
import { cx } from './ui';

const MODES: { id: DiffMode; label: string; hint: string }[] = [
  { id: 'all', label: 'Усе', hint: 'усі зміни відносно base_commit, включно з незакоміченими' },
  { id: 'committed', label: 'Коміти', hint: 'git diff base...agent/<slug>' },
  { id: 'working', label: 'Робочі', hint: 'git diff HEAD + нові файли' },
];

export interface LineComment {
  id: number;
  file: string;
  line: number;
  side: 'new' | 'old';
  code: string;
  text: string;
}

function loadComments(taskId: number): LineComment[] {
  try {
    return JSON.parse(localStorage.getItem(`vatra-comments-${taskId}`) ?? '[]');
  } catch {
    return [];
  }
}

/** Reads file / line / code of a clicked diff2html row (both layouts). */
function rowInfo(tr: HTMLTableRowElement): Omit<LineComment, 'id' | 'text'> | null {
  const wrapper = tr.closest('.d2h-file-wrapper');
  const file = wrapper?.querySelector('.d2h-file-name')?.textContent?.trim();
  if (!file || tr.querySelector('.d2h-info')) return null;
  let line = 0;
  let side: 'new' | 'old' = 'new';
  const n2 = tr.querySelector('.line-num2')?.textContent?.trim();
  const n1 = tr.querySelector('.line-num1')?.textContent?.trim();
  if (n2 || n1) {
    line = Number(n2 || n1);
    side = n2 ? 'new' : 'old';
  } else {
    const num = tr.querySelector('.d2h-code-side-linenumber')?.textContent?.trim();
    if (!num) return null;
    line = Number(num);
    const sides = wrapper ? [...wrapper.querySelectorAll('.d2h-file-side-diff')] : [];
    side = sides.length === 2 && sides[0].contains(tr) ? 'old' : 'new';
  }
  if (!line) return null;
  const code = (tr.querySelector('.d2h-code-line-ctn')?.textContent ?? '').replace(/\s+$/, '');
  return { file, line, side, code };
}

export function DiffView({
  taskId,
  refreshKey,
  enabled,
  toast,
}: {
  taskId: number;
  refreshKey: number;
  enabled: boolean;
  toast: (kind: 'error' | 'info' | 'success', title: string, body?: string) => void;
}) {
  const [comments, setComments] = useState<LineComment[]>(() => loadComments(taskId));
  const [draft, setDraft] = useState<{ info: Omit<LineComment, 'id' | 'text'>; top: number; text: string } | null>(null);
  const [showList, setShowList] = useState(false);
  const [sending, setSending] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<DiffMode>('all');
  const [layout, setLayout] = useState<'line-by-line' | 'side-by-side'>(() => {
    try {
      return (localStorage.getItem('vatra-diff-layout') as 'line-by-line' | 'side-by-side') || 'line-by-line';
    } catch {
      return 'line-by-line';
    }
  });
  const [data, setData] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem('vatra-diff-layout', layout);
    } catch {
      /* ignore */
    }
  }, [layout]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    api
      .diff(taskId, mode)
      .then((d) => {
        if (cancelled) return;
        // keep the scroll position across live refreshes
        const top = scroller.current?.scrollTop ?? 0;
        setData(d);
        setError(null);
        requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = top));
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [taskId, mode, refreshKey, enabled]);

  useEffect(() => {
    setData(null);
    setComments(loadComments(taskId));
    setDraft(null);
  }, [taskId]);

  useEffect(() => {
    try {
      localStorage.setItem(`vatra-comments-${taskId}`, JSON.stringify(comments));
    } catch {
      /* ignore */
    }
  }, [taskId, comments]);

  const rendered = useMemo(() => {
    if (!data?.patch) return '';
    return diffHtml(data.patch, {
      drawFileList: false,
      outputFormat: layout,
      matching: 'lines',
      diffStyle: 'word',
      colorScheme: 'dark',
      renderNothingWhenEmpty: false,
    } as Parameters<typeof diffHtml>[1]);
  }, [data, layout]);

  // mark commented lines after every render of the diff
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.querySelectorAll('tr.vatra-commented').forEach((tr) => tr.classList.remove('vatra-commented'));
    if (!comments.length) return;
    root.querySelectorAll('tr').forEach((tr) => {
      const info = rowInfo(tr as HTMLTableRowElement);
      if (info && comments.some((c) => c.file === info.file && c.line === info.line && c.side === info.side)) tr.classList.add('vatra-commented');
    });
  }, [rendered, comments]);

  const onDiffClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, .d2h-file-header')) return;
    if (window.getSelection()?.toString()) return; // selecting text, not commenting
    const tr = target.closest('tr') as HTMLTableRowElement | null;
    if (!tr || !host.current) return;
    const info = rowInfo(tr);
    if (!info) return;
    const top = tr.getBoundingClientRect().bottom - host.current.getBoundingClientRect().top;
    setDraft({ info, top, text: '' });
  };

  const addDraft = () => {
    if (!draft?.text.trim()) return;
    setComments((c) => [...c, { ...draft.info, id: Date.now(), text: draft.text.trim() }]);
    setDraft(null);
  };

  const send = async (extra?: LineComment) => {
    const all = extra ? [...comments, extra] : comments;
    if (!all.length) return;
    const body = all
      .map((c, i) => {
        const where = `\`${c.file}:${c.line}\`${c.side === 'old' ? ' (стара версія рядка)' : ''}`;
        const code = c.code.trim() ? ` — \`${c.code.trim().slice(0, 160)}\`` : '';
        return `${i + 1}. ${where}${code}\n   ${c.text.replace(/\n/g, '\n   ')}`;
      })
      .join('\n');
    const text = `Мої коментарі до твоїх змін (диф):\n\n${body}\n\nВиправ, будь ласка, і коротко напиши, що змінив.`;
    setSending(true);
    try {
      const r = await api.message(taskId, text);
      setComments([]);
      setDraft(null);
      setShowList(false);
      toast('success', `Надіслано агенту: ${all.length} коментар(ів)`, r.delivered === 'relaunch' ? 'Агента розбуджено з --resume' : undefined);
    } catch (e) {
      toast('error', 'Не надіслано', (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 h-10 border-b border-line shrink-0">
        <div className="flex rounded-md border border-line-2 overflow-hidden shrink-0">
          {MODES.map((m) => (
            <button
              key={m.id}
              title={m.hint}
              onClick={() => setMode(m.id)}
              className={cx('px-2.5 h-6 text-[12px] cursor-pointer', mode === m.id ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg')}
            >
              {m.label}
            </button>
          ))}
        </div>
        {data && (
          <div className="text-[12px] text-muted font-mono whitespace-nowrap truncate min-w-0">
            {data.stats.files} файл(ів) <span className="text-emerald-400">+{data.stats.additions}</span>{' '}
            <span className="text-red-400">−{data.stats.deletions}</span>
            {data.untracked.length > 0 && <span className="text-faint"> · нових: {data.untracked.length}</span>}
          </div>
        )}
        {loading && <span className="size-3 rounded-full border-2 border-muted border-t-transparent animate-spin" />}
        <div className="ml-auto flex rounded-md border border-line-2 overflow-hidden shrink-0">
          {(['line-by-line', 'side-by-side'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLayout(l)}
              className={cx('px-2.5 h-6 text-[12px] cursor-pointer', layout === l ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg')}
            >
              {l === 'line-by-line' ? 'Зведено' : 'Поруч'}
            </button>
          ))}
        </div>
      </div>
      {comments.length > 0 && (
        <div className="border-b border-line bg-amber-950/15 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2 text-[12px]">
            <button className="text-amber-200 hover:underline cursor-pointer" onClick={() => setShowList((v) => !v)}>
              💬 {comments.length} коментар(ів) до рядків {showList ? '▴' : '▾'}
            </button>
            <span className="ml-auto" />
            <button className="text-faint hover:text-red-300 cursor-pointer" onClick={() => confirm('Видалити всі коментарі?') && setComments([])}>
              очистити
            </button>
            <button
              className="h-6 px-2.5 rounded-md bg-accent-strong text-[#1c0b00] font-semibold disabled:opacity-50 cursor-pointer"
              disabled={sending}
              onClick={() => void send()}
            >
              {sending ? 'Надсилаю…' : 'Надіслати агенту'}
            </button>
          </div>
          {showList && (
            <ul className="mt-2 space-y-1 max-h-48 overflow-y-auto">
              {comments.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-[12px]">
                  <span className="font-mono text-sky-300 shrink-0">
                    {c.file}:{c.line}
                  </span>
                  <span className="text-muted flex-1 whitespace-pre-wrap">{c.text}</span>
                  <button className="text-faint hover:text-red-300 cursor-pointer" onClick={() => setComments((all) => all.filter((x) => x.id !== c.id))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div ref={scroller} className="flex-1 overflow-auto p-4 diff-host">
        {error && <div className="text-red-400 text-[12px]">{error}</div>}
        {data?.truncated && <div className="mb-3 text-amber-300 text-[12px]">Диф завеликий — показано початок.</div>}
        {data && !data.patch && !error && (
          <div className="h-full grid place-items-center text-muted text-[13px]">
            <div className="text-center">
              <div className="text-2xl mb-2 opacity-40">∅</div>
              Змін поки немає
            </div>
          </div>
        )}
        {rendered && (
          <div className="relative" ref={host}>
            <div onClick={onDiffClick} dangerouslySetInnerHTML={{ __html: rendered }} />
            {draft && (
              <div className="absolute left-0 right-0 z-20 px-2" style={{ top: draft.top + 2 }}>
                <div className="rounded-lg border border-accent/50 bg-panel-2 shadow-2xl p-2.5">
                  <div className="text-[11.5px] text-muted mb-1.5 font-mono truncate">
                    {draft.info.file}:{draft.info.line}
                    {draft.info.code.trim() && <span className="text-faint"> — {draft.info.code.trim().slice(0, 120)}</span>}
                  </div>
                  <textarea
                    autoFocus
                    rows={2}
                    value={draft.text}
                    onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setDraft(null);
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        addDraft();
                      }
                    }}
                    placeholder="Що тут не так або що змінити…"
                    className="w-full resize-y rounded-md bg-bg border border-line-2 px-2.5 py-1.5 text-[13px] outline-none focus:border-accent/60"
                  />
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="text-[11px] text-faint">⌘/Ctrl+Enter — додати до списку</span>
                    <span className="ml-auto" />
                    <button className="h-6 px-2 text-[12px] text-muted hover:text-fg cursor-pointer" onClick={() => setDraft(null)}>
                      Скасувати
                    </button>
                    <button className="h-6 px-2.5 rounded-md border border-line-2 text-[12px] hover:border-accent/60 cursor-pointer disabled:opacity-40" disabled={!draft.text.trim()} onClick={addDraft}>
                      Додати
                    </button>
                    <button
                      className="h-6 px-2.5 rounded-md bg-accent-strong text-[#1c0b00] font-semibold text-[12px] cursor-pointer disabled:opacity-40"
                      disabled={!draft.text.trim() || sending}
                      onClick={() => void send({ ...draft.info, id: Date.now(), text: draft.text.trim() })}
                    >
                      {comments.length ? `Надіслати всі (${comments.length + 1})` : 'Надіслати агенту'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
