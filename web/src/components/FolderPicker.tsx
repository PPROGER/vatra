import { useEffect, useState } from 'react';
import { api, type DirListing } from '../api';
import { Button, cx, inputCls, Modal } from './ui';

function prettyPath(p: string, home: string | null) {
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** In-app directory browser (works the same on macOS and Linux, no permissions needed). */
export function FolderBrowser({ start, onPick, onClose }: { start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState(start || '~');
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const home = listing?.shortcuts.find((s) => s.label === 'Домівка')?.path ?? null;

  const go = (p?: string, fallback = false) => {
    api
      .fsList(p, hidden)
      .then((l) => {
        setListing(l);
        setPathInput(l.path);
        setSelected(null);
        setFilter('');
        setError(null);
      })
      .catch((e) => (fallback ? go('~') : setError(e.message)));
  };

  useEffect(() => go(start || '~/Documents/projects', true), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (listing) go(listing.path);
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = (listing?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const target = selected ?? listing?.path ?? null;
  const targetIsGit = selected ? !!listing?.entries.find((e) => e.path === selected)?.isGit : !!listing?.isGit;

  return (
    <Modal title="Обрати папку проєкту" onClose={onClose} width="max-w-2xl">
      <div className="flex flex-wrap gap-1.5 mb-3">
        {listing?.shortcuts.map((s) => (
          <button
            key={s.path}
            onClick={() => go(s.path)}
            className={cx(
              'h-6 px-2 rounded-md border text-[12px] cursor-pointer',
              listing.path === s.path ? 'border-accent/60 text-fg bg-panel-2' : 'border-line-2 text-muted hover:text-fg',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <form
        className="flex gap-1.5 mb-2"
        onSubmit={(e) => {
          e.preventDefault();
          go(pathInput);
        }}
      >
        <Button type="button" variant="ghost" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)} title="Вгору">
          ↑
        </Button>
        <input className={inputCls + ' font-mono h-7 py-0'} value={pathInput} onChange={(e) => setPathInput(e.target.value)} />
        <input className={inputCls + ' h-7 py-0 w-40'} placeholder="фільтр…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </form>
      {error && <div className="text-red-400 text-[12px] mb-2">{error}</div>}
      <div className="h-80 overflow-y-auto rounded-md border border-line bg-bg">
        {entries.length === 0 && <div className="p-4 text-muted text-[12px]">Порожньо</div>}
        {entries.map((e) => (
          <div
            key={e.path}
            onClick={() => setSelected(e.path === selected ? null : e.path)}
            onDoubleClick={() => go(e.path)}
            className={cx(
              'flex items-center gap-2 px-3 h-8 cursor-pointer select-none border-b border-line/50',
              selected === e.path ? 'bg-accent/10' : 'hover:bg-panel-2',
            )}
          >
            <span className={cx('text-[14px]', e.isGit ? 'text-accent' : 'text-faint')}>{e.isGit ? '◆' : '▸'}</span>
            <span className={cx('truncate', e.hidden ? 'text-faint' : 'text-fg')}>{e.name}</span>
            {e.isGit && <span className="text-[10px] uppercase tracking-wider text-accent/80 border border-accent/30 rounded px-1">git</span>}
            <button
              className="ml-auto text-faint hover:text-fg text-[12px] px-1 cursor-pointer"
              onClick={(ev) => {
                ev.stopPropagation();
                go(e.path);
              }}
              title="Відкрити"
            >
              →
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-3">
        <label className="flex items-center gap-1.5 text-[12px] text-muted cursor-pointer">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          приховані
        </label>
        <div className="text-[12px] text-muted truncate flex-1 font-mono" title={target ?? ''}>
          {target ? prettyPath(target, home) : ''}
          {target && !targetIsGit && <span className="text-amber-300 font-sans"> · не git-репозиторій</span>}
        </div>
        <Button variant="ghost" onClick={onClose}>
          Скасувати
        </Button>
        <Button variant="primary" disabled={!target} onClick={() => target && onPick(target)}>
          Обрати
        </Button>
      </div>
      <div className="text-[11px] text-faint mt-2">Клік — виділити, подвійний клік — увійти в папку.</div>
    </Modal>
  );
}
