// Rendering of individual chat items: messages, tool calls, system lines.
import { memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatItem } from '../../../server/shared/types';
import { describeTool } from '../../../server/shared/tools';
import { api } from '../api';
import { cx } from './ui';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const ATTACH_RE = /\s*\[прикріплені файли — прочитай через Read: ([^\]]+)\]\s*$/;

export function withAttachments(text: string, files: string[]): string {
  return files.length ? `${text}${text ? ' ' : ''}[прикріплені файли — прочитай через Read: ${files.join(', ')}]` : text;
}

export function splitAttachments(text: string): { body: string; files: string[] } {
  const m = text.match(ATTACH_RE);
  if (!m) return { body: text, files: [] };
  return { body: text.slice(0, m.index).trim(), files: m[1].split(', ').map((f) => f.trim()).filter(Boolean) };
}

const IMG_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

const fileName = (p: string) => p.split('/').pop()?.replace(/^\d{14}-[0-9a-f]{4}-/, '') ?? p;

export function AttachmentChips({ fileUrl, files, onRemove }: { fileUrl: (path: string) => string; files: { path: string; name?: string; preview?: string }[]; onRemove?: (path: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => {
        const isImg = IMG_RE.test(f.path) || !!f.preview;
        return (
          <div key={f.path} className="group relative flex items-center gap-1.5 rounded-md border border-line-2 bg-bg/60 pr-2 overflow-hidden max-w-56">
            {isImg ? (
              <a href={f.preview ?? fileUrl(f.path)} target="_blank" rel="noreferrer">
                <img src={f.preview ?? fileUrl(f.path)} className="size-9 object-cover" alt="" />
              </a>
            ) : (
              <span className="size-9 grid place-items-center text-faint text-[15px]">▤</span>
            )}
            <span className="truncate text-[12px] text-muted">{f.name ?? fileName(f.path)}</span>
            {onRemove && (
              <button className="ml-1 text-faint hover:text-red-400 cursor-pointer" onClick={() => onRemove(f.path)} title="Прибрати">
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export type Delivery = 'sending' | 'sent' | 'delivered' | 'answered' | 'error';

function Ticks({ state }: { state: Delivery }) {
  const map: Record<Delivery, [string, string, string]> = {
    sending: ['◷', 'text-faint', 'Надсилається'],
    sent: ['✓', 'text-faint', 'Надіслано в термінал агента'],
    delivered: ['✓✓', 'text-sky-400', 'Агент отримав'],
    answered: ['✓✓', 'text-accent', 'Агент відповів'],
    error: ['!', 'text-red-400', 'Не вдалося надіслати'],
  };
  const [glyph, cls, title] = map[state];
  return (
    <span className={cx('text-[11px] font-mono', cls)} title={title}>
      {glyph}
    </span>
  );
}

const time = (ts: string) => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function UserBubble({ taskId, text, ts, command, bash, delivery, onRetry }: { taskId: number; text: string; ts: string; command?: string; bash?: boolean; delivery: Delivery; onRetry?: () => void }) {
  const split = splitAttachments(text);
  const { body, files } = split.body || split.files.length ? split : { body: text, files: [] };
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] min-w-0">
        <div
          className={cx(
            'rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words',
            command || bash ? 'bg-[#1b2230] border border-[#2b3546] font-mono text-[12.5px] text-sky-200' : 'bg-[#2b1c12] border border-[#4a2f1b] text-[#fff4ea]',
          )}
        >
          {body}
          {files.length > 0 && (
            <div className={body ? 'mt-2' : ''}>
              <AttachmentChips fileUrl={(p) => api.uploadUrl(taskId, p)} files={files.map((path) => ({ path }))} />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-0.5 pr-1">
          {delivery === 'error' && onRetry && (
            <button className="text-[11px] text-red-400 hover:underline cursor-pointer" onClick={onRetry}>
              повторити
            </button>
          )}
          <span className="text-[10.5px] text-faint">{time(ts)}</span>
          <Ticks state={delivery} />
        </div>
      </div>
    </div>
  );
}

export const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  return (
    <div className="md max-w-[92%] text-[13.5px] leading-relaxed">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {text}
      </Markdown>
    </div>
  );
});

export function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[12px]">
      <button className="text-faint hover:text-muted cursor-pointer italic" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} думки
      </button>
      {open && <div className="mt-1 pl-3 border-l border-line-2 text-muted whitespace-pre-wrap">{text}</div>}
    </div>
  );
}

export function SystemLine({ text, tone }: { text: string; tone?: 'info' | 'error' | 'output' }) {
  if (tone === 'output')
    return <pre className="text-[12px] font-mono text-muted bg-panel border border-line rounded-lg px-3 py-2 overflow-x-auto max-h-80 whitespace-pre-wrap">{text}</pre>;
  return <div className={cx('text-center text-[11.5px]', tone === 'error' ? 'text-red-400' : 'text-faint')}>{text}</div>;
}

const TOOL_ICON: Record<string, string> = {
  Bash: '$',
  Read: '◱',
  Write: '✎',
  Edit: '✎',
  MultiEdit: '✎',
  Glob: '⌕',
  Grep: '⌕',
  WebFetch: '⇣',
  WebSearch: '⌕',
  Task: '◎',
  Agent: '◎',
  TodoWrite: '☑',
};

function str(v: unknown) {
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2);
}

function MiniDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const o = oldText.split('\n');
  const n = newText.split('\n');
  return (
    <pre className="text-[12px] font-mono leading-snug overflow-x-auto max-h-80 rounded-md border border-line bg-bg">
      {o.map((l, i) => (
        <div key={'o' + i} className="bg-red-500/10 text-red-200 px-2">
          − {l}
        </div>
      ))}
      {n.map((l, i) => (
        <div key={'n' + i} className="bg-emerald-500/10 text-emerald-200 px-2">
          + {l}
        </div>
      ))}
    </pre>
  );
}

function ToolDetails({ item }: { item: ToolItem }) {
  const i = item.input;
  let body: React.ReactNode;
  switch (item.name) {
    case 'Bash':
      body = <pre className="text-[12px] font-mono bg-bg border border-line rounded-md px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap">$ {str(i.command)}</pre>;
      break;
    case 'Edit':
      body = <MiniDiff oldText={str(i.old_string)} newText={str(i.new_string)} />;
      break;
    case 'MultiEdit':
      body = (Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []).map((e, k) => <MiniDiff key={k} oldText={str(e.old_string)} newText={str(e.new_string)} />);
      break;
    case 'Write':
      body = <pre className="text-[12px] font-mono bg-bg border border-line rounded-md px-2.5 py-1.5 overflow-x-auto max-h-80">{str(i.content).split('\n').slice(0, 60).join('\n')}</pre>;
      break;
    case 'TodoWrite':
      body = (
        <ul className="space-y-0.5">
          {(Array.isArray(i.todos) ? (i.todos as Record<string, unknown>[]) : []).map((t, k) => (
            <li key={k} className={cx('text-[12.5px]', t.status === 'completed' ? 'text-faint line-through' : t.status === 'in_progress' ? 'text-amber-200' : 'text-muted')}>
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} {str(t.content)}
            </li>
          ))}
        </ul>
      );
      break;
    default:
      body = <pre className="text-[12px] font-mono bg-bg border border-line rounded-md px-2.5 py-1.5 overflow-x-auto max-h-60">{JSON.stringify(i, null, 2)}</pre>;
  }
  return (
    <div className="mt-1.5 space-y-1.5">
      {body}
      {item.result !== undefined && item.name !== 'TodoWrite' && (
        <pre
          className={cx(
            'text-[12px] font-mono rounded-md px-2.5 py-1.5 overflow-x-auto max-h-72 whitespace-pre-wrap border',
            item.isError ? 'border-red-900/60 bg-red-950/20 text-red-300' : 'border-line bg-panel text-muted',
          )}
        >
          {item.result || '(порожньо)'}
        </pre>
      )}
    </div>
  );
}

export function ToolRow({ item, root }: { item: ToolItem; root?: string }) {
  // todo lists are worth seeing without a click
  const [open, setOpen] = useState(item.name === 'TodoWrite');
  const desc = describeTool(item.name, item.input);
  let label = desc.startsWith(item.name + ':') ? desc.slice(item.name.length + 1).trim() : desc;
  if (root && label.startsWith(root + '/')) label = label.slice(root.length + 1);
  return (
    <div className="text-[12.5px]">
      <button className="w-full flex items-center gap-2 text-left cursor-pointer group" onClick={() => setOpen((o) => !o)}>
        <span className="w-4 text-center font-mono text-faint">{TOOL_ICON[item.name] ?? '•'}</span>
        <span className="text-muted font-medium">{item.name}</span>
        <span className="truncate text-faint font-mono text-[12px] group-hover:text-muted">{label !== item.name ? label : ''}</span>
        <span className="ml-auto shrink-0">
          {!item.done ? (
            <span className="inline-block size-3 rounded-full border-2 border-muted border-t-transparent animate-spin" />
          ) : item.isError ? (
            <span className="text-red-400">✗</span>
          ) : (
            <span className="text-emerald-500/80">✓</span>
          )}
        </span>
      </button>
      {open && <ToolDetails item={item} />}
    </div>
  );
}

export function ToolGroup({ items, root }: { items: ToolItem[]; root?: string }) {
  return (
    <div className="max-w-[92%] rounded-lg border border-line bg-panel/60 px-3 py-2 space-y-1.5">
      {items.map((t) => (
        <ToolRow key={t.id} item={t} root={root} />
      ))}
    </div>
  );
}
