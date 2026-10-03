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

export function DiffView({ taskId, refreshKey, enabled }: { taskId: number; refreshKey: number; enabled: boolean }) {
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

  useEffect(() => setData(null), [taskId]);

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
        {rendered && <div dangerouslySetInnerHTML={{ __html: rendered }} />}
      </div>
    </div>
  );
}
