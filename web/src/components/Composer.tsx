// Message composer: slash-command and @file autocomplete, attachments, drag&drop, paste.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { SlashCommand } from '../../../server/shared/types';
import { api, type ComposerScope } from '../api';
import { AttachmentChips } from './ChatItems';
import { cx } from './ui';

export interface Attachment {
  path: string;
  name: string;
  preview?: string;
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
  insert: (text: string) => void;
}

type Popup = { kind: 'slash'; items: SlashCommand[] } | { kind: 'file'; items: string[]; start: number } | null;

export const Composer = forwardRef<ComposerHandle, {
  scope: ComposerScope;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder: string;
  sendLabel?: string;
  /** Return false (or a promise of false) to put the text back, e.g. when creating failed. */
  onSend: (text: string, attachments: Attachment[]) => void | boolean | Promise<void | boolean>;
  onError: (m: string) => void;
}>(function Composer({ scope, disabled, autoFocus, placeholder, sendLabel = 'Надіслати', onSend, onError }, ref) {
  const ep = useMemo(() => api.composer(scope), [scope.kind, scope.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [popup, setPopup] = useState<Popup>(null);
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);

  useEffect(() => {
    ep.commands().then(setCommands).catch(() => {});
    setText('');
    setAttachments([]);
    if (autoFocus) ta.current?.focus();
  }, [ep]); // eslint-disable-line react-hooks/exhaustive-deps

  // autosize
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
  }, [text]);

  const addFiles = (files: File[]) => {
    for (const f of files) {
      setUploading((n) => n + 1);
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
      const named = f.name ? f : new File([f], `вставка-${Date.now()}.png`, { type: f.type });
      ep
        .upload(named)
        .then((r) => setAttachments((a) => [...a, { path: r.path, name: r.name, preview }]))
        .catch((e) => onError(`Не вдалося завантажити ${f.name}: ${e.message}`))
        .finally(() => setUploading((n) => n - 1));
    }
  };

  useImperativeHandle(ref, () => ({
    addFiles,
    focus: () => ta.current?.focus(),
    insert: (t: string) => {
      setText((cur) => (cur ? cur.replace(/\s*$/, ' ') : '') + t);
      ta.current?.focus();
    },
  }));

  // compute popup from the text before the caret
  const updatePopup = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    if (/^\/[^\s]*$/.test(before)) {
      const q = before.slice(1).toLowerCase();
      const items = commands
        .filter((c) => c.name.slice(1).toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.slice(1).toLowerCase().startsWith(q)) - Number(!b.name.slice(1).toLowerCase().startsWith(q)))
        .slice(0, 12);
      setPopup(items.length ? { kind: 'slash', items } : null);
      setSel(0);
      return;
    }
    const m = before.match(/(^|\s)@([^\s]*)$/);
    if (m) {
      const q = m[2];
      const start = caret - q.length - 1;
      ep
        .files(q)
        .then((items) => {
          setPopup(items.length ? { kind: 'file', items, start } : null);
          setSel(0);
        })
        .catch(() => setPopup(null));
      return;
    }
    setPopup(null);
  };

  const choose = (i: number) => {
    if (!popup) return;
    const el = ta.current!;
    const caret = el.selectionStart;
    if (popup.kind === 'slash') {
      const c = popup.items[i];
      const rest = text.slice(caret);
      const next = c.name + ' ' + rest.replace(/^\S*\s?/, '');
      setText(next);
      setPopup(null);
      requestAnimationFrame(() => el.setSelectionRange(c.name.length + 1, c.name.length + 1));
    } else {
      const f = popup.items[i];
      const next = text.slice(0, popup.start) + '@' + f + (f.endsWith('/') ? '' : ' ') + text.slice(caret);
      const pos = popup.start + 1 + f.length + (f.endsWith('/') ? 0 : 1);
      setText(next);
      requestAnimationFrame(() => {
        el.setSelectionRange(pos, pos);
        if (f.endsWith('/')) updatePopup(next, pos);
        else setPopup(null);
      });
    }
  };

  const send = () => {
    const t = text.trim();
    if ((!t && !attachments.length) || uploading || disabled) return;
    const sentAttachments = attachments;
    void Promise.resolve(onSend(t, attachments)).then((ok) => {
      if (ok === false) {
        setText(t);
        setAttachments(sentAttachments);
      }
    });
    if (t) history.current = [t, ...history.current.filter((h) => h !== t)].slice(0, 50);
    histPos.current = -1;
    setText('');
    setAttachments([]);
    setPopup(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (popup) {
      const n = popup.items.length;
      if (e.key === 'ArrowDown') return e.preventDefault(), setSel((s) => (s + 1) % n);
      if (e.key === 'ArrowUp') return e.preventDefault(), setSel((s) => (s - 1 + n) % n);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        // Enter on an exact command match sends it; otherwise completes
        if (e.key === 'Enter' && popup.kind === 'slash' && popup.items[sel]?.name === text.trim()) {
          e.preventDefault();
          return send();
        }
        e.preventDefault();
        return choose(sel);
      }
      if (e.key === 'Escape') return e.preventDefault(), setPopup(null);
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return send();
    }
    // shell-like history when the box is empty or browsing history
    if (e.key === 'ArrowUp' && (!text || histPos.current >= 0) && history.current.length) {
      e.preventDefault();
      histPos.current = Math.min(histPos.current + 1, history.current.length - 1);
      setText(history.current[histPos.current]);
    } else if (e.key === 'ArrowDown' && histPos.current >= 0) {
      e.preventDefault();
      histPos.current -= 1;
      setText(histPos.current >= 0 ? history.current[histPos.current] : '');
    }
  };

  const mode = text.startsWith('!') ? 'bash' : text.startsWith('/') ? 'command' : text.startsWith('#') ? 'memory' : null;
  const matched = useMemo(() => (mode === 'command' ? commands.find((c) => c.name === text.trim().split(/\s/)[0]) : undefined), [mode, text, commands]);

  return (
    <div className="relative">
      {popup && (
        <div className="absolute bottom-full mb-2 left-0 right-0 z-30 max-h-72 overflow-y-auto rounded-lg border border-line-2 bg-panel-2 shadow-2xl p-1">
          {popup.kind === 'slash'
            ? popup.items.map((c, i) => (
                <button
                  key={c.name}
                  onMouseDown={(e) => (e.preventDefault(), choose(i))}
                  onMouseEnter={() => setSel(i)}
                  className={cx('w-full flex items-baseline gap-2 text-left rounded-md px-2.5 py-1.5 cursor-pointer', i === sel && 'bg-[#232933]')}
                >
                  <span className="font-mono text-[12.5px] text-sky-300">{c.name}</span>
                  {c.args && <span className="font-mono text-[11px] text-faint">{c.args}</span>}
                  <span className="text-[12px] text-muted truncate">{c.description}</span>
                  <span className="ml-auto flex gap-1 shrink-0">
                    {c.interactive && <span className="text-[10px] rounded border border-amber-700/50 text-amber-300/90 px-1">термінал</span>}
                    {c.source !== 'builtin' && <span className="text-[10px] rounded border border-line-2 text-faint px-1">{c.source}</span>}
                  </span>
                </button>
              ))
            : popup.items.map((f, i) => (
                <button
                  key={f}
                  onMouseDown={(e) => (e.preventDefault(), choose(i))}
                  onMouseEnter={() => setSel(i)}
                  className={cx('w-full text-left rounded-md px-2.5 py-1 font-mono text-[12px] cursor-pointer truncate', i === sel ? 'bg-[#232933] text-fg' : 'text-muted')}
                >
                  {f.endsWith('/') ? '▸ ' : ''}
                  {f}
                </button>
              ))}
        </div>
      )}

      <div
        className={cx(
          'rounded-xl border bg-panel transition-colors',
          mode === 'bash' ? 'border-violet-700/60' : mode === 'command' ? 'border-sky-800/70' : 'border-line-2 focus-within:border-accent/50',
        )}
      >
        {(attachments.length > 0 || uploading > 0) && (
          <div className="px-3 pt-2.5 flex items-center gap-2">
            <AttachmentChips fileUrl={ep.fileUrl} files={attachments} onRemove={(p) => setAttachments((a) => a.filter((x) => x.path !== p))} />
            {uploading > 0 && <span className="size-3.5 rounded-full border-2 border-muted border-t-transparent animate-spin" />}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            histPos.current = -1;
            updatePopup(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => updatePopup(text, (e.target as HTMLTextAreaElement).selectionStart)}
          onBlur={() => setTimeout(() => setPopup(null), 120)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <button
            className="size-7 grid place-items-center rounded-md text-muted hover:text-fg hover:bg-panel-2 cursor-pointer"
            title="Прикріпити файли (або перетягни / встав з буфера)"
            onClick={() => fileInput.current?.click()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
            </svg>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button className="h-7 px-2 rounded-md text-[12px] font-mono text-muted hover:text-fg hover:bg-panel-2 cursor-pointer" title="Slash-команди" onClick={() => (setText('/'), updatePopup('/', 1), ta.current?.focus())}>
            /
          </button>
          <button className="h-7 px-2 rounded-md text-[12px] font-mono text-muted hover:text-fg hover:bg-panel-2 cursor-pointer" title="Згадати файл з репо" onClick={() => {
            const next = text + (text && !text.endsWith(' ') ? ' @' : '@');
            setText(next);
            updatePopup(next, next.length);
            ta.current?.focus();
          }}>
            @
          </button>
          <span className="ml-1 text-[11px] text-faint truncate">
            {mode === 'bash' && 'bash-режим: команда виконається в shell агента'}
            {mode === 'command' && (matched ? `${matched.description}${matched.interactive ? ' · відкриється в терміналі' : ''}` : 'slash-команда')}
            {mode === 'memory' && 'запис у памʼять (CLAUDE.md)'}
            {!mode && 'Enter — надіслати · Shift+Enter — новий рядок · ↑ — історія'}
          </span>
          <button
            onClick={send}
            disabled={disabled || uploading > 0 || (!text.trim() && !attachments.length)}
            className="ml-auto h-7 px-3 rounded-lg bg-accent-strong text-[#1c0b00] font-semibold text-[12px] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-accent"
          >
            {sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
});
