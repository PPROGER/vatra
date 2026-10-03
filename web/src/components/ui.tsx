import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TaskStatus } from '../../../server/shared/types';
import { t, tk } from '../i18n';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost';
export function Button({
  children,
  variant = 'default',
  busy,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; busy?: boolean }) {
  const styles: Record<BtnVariant, string> = {
    default: 'bg-panel-2 border-line-2 text-fg hover:bg-[#1f242c] hover:border-[#3a4150]',
    primary: 'bg-accent-strong border-accent-strong text-[#1c0b00] font-semibold hover:bg-accent',
    danger: 'bg-transparent border-[#4a2327] text-[#f87171] hover:bg-[#2a1417]',
    ghost: 'bg-transparent border-transparent text-muted hover:text-fg hover:bg-panel-2',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[12px] whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
        styles[variant],
        className,
      )}
    >
      {busy && <span className="size-3 rounded-full border-2 border-current border-t-transparent animate-spin" />}
      {children}
    </button>
  );
}

export const STATUS_META: Record<TaskStatus, { label: string; dot: string; text: string; pulse?: boolean }> = {
  creating: { label: tk('створюється'), dot: 'bg-sky-400', text: 'text-sky-300', pulse: true },
  queued: { label: tk('в черзі'), dot: 'bg-slate-400', text: 'text-slate-300' },
  running: { label: tk('працює'), dot: 'bg-emerald-400', text: 'text-emerald-300', pulse: true },
  idle: { label: tk('чекає'), dot: 'bg-amber-400', text: 'text-amber-300' },
  review: { label: tk('ревʼю'), dot: 'bg-violet-400', text: 'text-violet-300' },
  sleeping: { label: tk('спить'), dot: 'bg-indigo-400/70', text: 'text-indigo-300' },
  merged: { label: tk('злито'), dot: 'bg-emerald-700', text: 'text-emerald-500' },
  discarded: { label: tk('відкинуто'), dot: 'bg-zinc-600', text: 'text-zinc-500' },
  done: { label: tk('завершено'), dot: 'bg-sky-700', text: 'text-sky-400' },
  error: { label: tk('помилка'), dot: 'bg-red-500', text: 'text-red-400' },
};

export function StatusDot({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status];
  return <span className={cx('inline-block size-2 rounded-full shrink-0', m.dot, m.pulse && 'pulse-dot')} />;
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 h-5 px-2 rounded-full bg-panel-2 border border-line text-[11px]', m.text)}>
      <StatusDot status={status} />
      {t(m.label)}
    </span>
  );
}

export function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-[2px] p-4 pt-[12vh]" onMouseDown={onClose}>
      <div className={cx('w-full rounded-xl border border-line-2 bg-panel shadow-2xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-11 border-b border-line">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <button className="text-muted hover:text-fg text-lg leading-none cursor-pointer" onClick={onClose} aria-label={t('Закрити')}>
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block mb-3.5">
      <span className="block text-[12px] text-muted mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-faint mt-1">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md bg-bg border border-line-2 px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/15';

/** Small dropdown menu anchored to a button. */
export interface MenuItem {
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Starts a new group with this heading. */
  section?: string;
}

export function Menu({
  label,
  items,
  variant = 'default',
  disabled,
  chevron = true,
  title,
}: {
  label: ReactNode;
  items: MenuItem[];
  variant?: BtnVariant;
  disabled?: boolean;
  chevron?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button variant={variant} onClick={() => setOpen((o) => !o)} disabled={disabled} title={title}>
        {label}
        {chevron && (
          <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-70">
            <path d="M2 4l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.5" />
          </svg>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 top-8 z-40 min-w-60 max-h-[70vh] overflow-y-auto rounded-lg border border-line-2 bg-panel-2 p-1 shadow-xl">
          {items.map((it, i) => (
            <div key={it.label}>
              {it.section && (
                <div className={cx('px-2.5 pb-1 text-[10.5px] uppercase tracking-wider text-faint', i > 0 ? 'pt-2 mt-1 border-t border-line' : 'pt-1')}>{it.section}</div>
              )}
              <button
                disabled={it.disabled}
                className={cx(
                  'w-full text-left rounded-md px-2.5 py-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
                  !it.disabled && 'hover:bg-[#232933]',
                  it.danger ? 'text-red-400' : 'text-fg',
                )}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                <div className="text-[12px]">{it.label}</div>
                {it.hint && <div className="text-[11px] text-faint">{it.hint}</div>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  title: string;
  body?: string;
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-96 max-w-[calc(100vw-2rem)]">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            'rounded-lg border bg-panel-2 px-3.5 py-2.5 shadow-xl cursor-pointer',
            toast.kind === 'error' ? 'border-red-900/70' : toast.kind === 'success' ? 'border-emerald-900/70' : 'border-line-2',
          )}
          onClick={() => dismiss(toast.id)}
        >
          <div className={cx('text-[12px] font-medium', toast.kind === 'error' ? 'text-red-300' : toast.kind === 'success' ? 'text-emerald-300' : 'text-fg')}>{toast.title}</div>
          {toast.body && <div className="text-[12px] text-muted mt-0.5 whitespace-pre-wrap break-words">{toast.body}</div>}
        </div>
      ))}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('щойно');
  if (s < 3600) return t('{n} хв', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} год', { n: Math.floor(s / 3600) });
  return t('{n} д', { n: Math.floor(s / 86400) });
}
