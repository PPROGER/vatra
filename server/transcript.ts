// Turns Claude Code's session transcript (~/.claude/projects/<cwd>/<session>.jsonl,
// path comes from hook payloads) into chat items, tailing the file live.
import { tr } from './shared/i18n/index.js';
import { closeSync, existsSync, fstatSync, openSync, readSync, unwatchFile, watchFile } from 'node:fs';
import type { ChatContext, ChatItem, ChatState, ServerEvent } from './shared/types.js';

const MAX_ITEMS = 1500;
const MAX_TEXT = 20_000;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + '\n… ' + tr('({count} символів обрізано)', { count: s.length - n }) : s);

function clipInput(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return clip(v);
  if (depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => clipInput(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = clipInput(x, depth + 1);
    return o;
  }
  return v;
}

function tag(s: string, name: string): string | null {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>;
          if (o.type === 'text' && typeof o.text === 'string') return o.text;
          if (o.type === 'image') return tr('[зображення]');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Context window guess: [1m] model variants or usage beyond 200k mean the 1M window. */
export function contextWindowFor(model: string | null, used: number, override?: number | null): number {
  if (override) return override;
  if (model && /\[1m\]|-1m\b/i.test(model)) return 1_000_000;
  return used > 200_000 ? 1_000_000 : 200_000;
}

export class TranscriptParser {
  items: ChatItem[] = [];
  private index = new Map<string, number>();
  context: ChatContext | null = null;

  constructor(private readonly windowOverride: number | null = null) {}

  private upsert(item: ChatItem, changed: Map<string, ChatItem>) {
    const i = this.index.get(item.id);
    if (i === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[i] = item;
    }
    changed.set(item.id, item);
  }

  private trim() {
    if (this.items.length <= MAX_ITEMS + 200) return;
    this.items = this.items.slice(-MAX_ITEMS);
    this.index = new Map(this.items.map((it, i) => [it.id, i]));
  }

  /** Feeds one JSONL record. Returns the items it created or changed. */
  feed(obj: Record<string, unknown>, changed = new Map<string, ChatItem>()): Map<string, ChatItem> {
    if (!obj || typeof obj !== 'object' || obj.isSidechain) return changed;
    const type = obj.type;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString();
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : `${ts}:${Math.random()}`;
    const msg = (obj.message ?? {}) as Record<string, unknown>;

    if (type === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      content.forEach((b: Record<string, unknown>, i: number) => {
        if (b?.type === 'text' && typeof b.text === 'string') {
          const text = b.text.trim();
          if (text && text !== '(no content)') this.upsert({ kind: 'assistant', id: `${uuid}:${i}`, ts, text: clip(text) }, changed);
        } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          this.upsert({ kind: 'thinking', id: `${uuid}:${i}`, ts, text: clip(b.thinking.trim(), 8000) }, changed);
        } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
          const prev = this.index.has(b.id) ? (this.items[this.index.get(b.id)!] as Extract<ChatItem, { kind: 'tool' }>) : null;
          this.upsert(
            {
              kind: 'tool',
              id: b.id,
              ts,
              name: String(b.name ?? 'tool'),
              input: (clipInput(b.input ?? {}) as Record<string, unknown>) ?? {},
              result: prev?.result,
              isError: prev?.isError,
              done: prev?.done ?? false,
            },
            changed,
          );
        }
      });
      const usage = msg.usage as Record<string, number> | undefined;
      const model = typeof msg.model === 'string' && msg.model !== '<synthetic>' ? msg.model : null;
      if (usage && model) {
        const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
        this.context = { model, usedTokens: used, windowTokens: contextWindowFor(model, used, this.windowOverride) };
      }
      this.trim();
      return changed;
    }

    if (type === 'user') {
      if (obj.isMeta) return changed;
      if (obj.isCompactSummary) {
        this.upsert({ kind: 'system', id: uuid, ts, text: tr('Контекст стиснуто — розмова продовжується з короткого підсумку'), tone: 'info' }, changed);
        this.context = this.context ? { ...this.context, usedTokens: 0 } : null;
        return changed;
      }
      const content = msg.content;
      if (Array.isArray(content)) {
        let textParts: string[] = [];
        for (const b of content as Record<string, unknown>[]) {
          if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            const i = this.index.get(b.tool_use_id);
            if (i !== undefined) {
              const tool = this.items[i] as Extract<ChatItem, { kind: 'tool' }>;
              this.upsert({ ...tool, result: clip(stripAnsi(toolResultText(b.content))), isError: !!b.is_error, done: true }, changed);
            }
          } else if (b?.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text);
          } else if (b?.type === 'image') {
            textParts.push(tr('[зображення]'));
          }
        }
        const text = textParts.join('\n').trim();
        if (text) this.userText(uuid, ts, text, changed);
        textParts = [];
      } else if (typeof content === 'string') {
        this.userText(uuid, ts, content, changed);
      }
      this.trim();
      return changed;
    }

    if (type === 'system') {
      if (obj.subtype === 'compact_boundary') {
        this.upsert({ kind: 'system', id: uuid, ts, text: tr('— контекст стиснуто —'), tone: 'info' }, changed);
      } else if (typeof obj.content === 'string' && obj.content.trim()) {
        const text = stripAnsi(obj.content).trim();
        const out = tag(text, 'local-command-stdout');
        if (out !== null) {
          if (out.trim()) this.upsert({ kind: 'system', id: uuid, ts, text: clip(out.trim()), tone: 'output' }, changed);
        } else if (!/^\s*<command-/.test(text)) {
          this.upsert({ kind: 'system', id: uuid, ts, text: clip(text), tone: obj.level === 'error' ? 'error' : 'info' }, changed);
        }
      }
    }
    return changed;
  }

  private userText(uuid: string, ts: string, raw: string, changed: Map<string, ChatItem>) {
    const s = raw.trim();
    if (!s || s.startsWith('Caveat: The messages below were generated')) return;
    const cmd = tag(s, 'command-name');
    if (cmd !== null) {
      const args = (tag(s, 'command-args') ?? '').trim();
      const name = cmd.trim().startsWith('/') ? cmd.trim() : `/${cmd.trim()}`;
      this.upsert({ kind: 'user', id: uuid, ts, text: args ? `${name} ${args}` : name, command: name }, changed);
      return;
    }
    const stdout = tag(s, 'local-command-stdout');
    const stderr = tag(s, 'local-command-stderr');
    if (stdout !== null || stderr !== null) {
      const text = stripAnsi([stdout, stderr].filter(Boolean).join('\n')).trim();
      if (text) this.upsert({ kind: 'system', id: uuid, ts, text: clip(text), tone: stderr ? 'error' : 'output' }, changed);
      return;
    }
    const bashIn = tag(s, 'bash-input');
    if (bashIn !== null) {
      this.upsert({ kind: 'user', id: uuid, ts, text: `!${bashIn}`, bash: true }, changed);
      return;
    }
    const bashOut = tag(s, 'bash-stdout');
    const bashErr = tag(s, 'bash-stderr');
    if (bashOut !== null || bashErr !== null) {
      const text = stripAnsi([bashOut, bashErr].filter(Boolean).join('\n')).trim();
      this.upsert({ kind: 'system', id: uuid, ts, text: clip(text || tr('(порожній вивід)')), tone: bashErr && !bashOut ? 'error' : 'output' }, changed);
      return;
    }
    if (/^\[Request interrupted by user/.test(s)) {
      this.upsert({ kind: 'system', id: uuid, ts, text: tr('Перервано користувачем'), tone: 'info' }, changed);
      return;
    }
    this.upsert({ kind: 'user', id: uuid, ts, text: clip(s) }, changed);
  }
}

/** Follows a growing JSONL file and reports parsed changes. */
export class TranscriptTail {
  readonly parser: TranscriptParser;
  private offset = 0;
  private partial = '';
  private stopped = false;

  constructor(
    readonly path: string,
    private readonly onChange: (items: ChatItem[], context: ChatContext | null) => void,
    windowOverride: number | null = null,
  ) {
    this.parser = new TranscriptParser(windowOverride);
    this.read(true);
    watchFile(path, { interval: 400 }, () => this.read(false));
  }

  read(initial: boolean) {
    if (this.stopped || !existsSync(this.path)) return;
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // file was rewritten — start over
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      const changed = new Map<string, ChatItem>();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.parser.feed(JSON.parse(line), changed);
        } catch {
          /* skip malformed line */
        }
      }
      if (changed.size && !initial) this.onChange([...changed.values()], this.parser.context);
    } finally {
      closeSync(fd);
    }
  }

  stop() {
    this.stopped = true;
    unwatchFile(this.path);
  }
}

/** Per-task chat state: transcript tail plus live hook-derived status. */
export class ChatHub {
  private tails = new Map<number, TranscriptTail>();
  private meta = new Map<number, { permission: ChatState['permission']; activity: string | null; sessionId: string | null }>();

  constructor(
    private readonly emit: (e: ServerEvent) => void,
    private readonly windowOverride: number | null = null,
  ) {}

  /** Starts (or switches) following a transcript file for a task. */
  follow(taskId: number, path: string, sessionId: string | null) {
    const cur = this.tails.get(taskId);
    if (cur?.path === path) return;
    cur?.stop();
    const tail = new TranscriptTail(path, (items, context) => this.emit({ type: 'chat', taskId, items, context }), this.windowOverride);
    this.tails.set(taskId, tail);
    const m = this.metaOf(taskId);
    m.sessionId = sessionId;
    if (cur) this.emit({ type: 'chat_reset', taskId });
  }

  private metaOf(taskId: number) {
    let m = this.meta.get(taskId);
    if (!m) {
      m = { permission: null, activity: null, sessionId: null };
      this.meta.set(taskId, m);
    }
    return m;
  }

  setMeta(taskId: number, patch: Partial<{ permission: ChatState['permission']; activity: string | null }>) {
    const m = this.metaOf(taskId);
    const next = { ...m, ...patch };
    if (next.permission === m.permission && next.activity === m.activity) return;
    Object.assign(m, patch);
    this.emit({ type: 'chat_meta', taskId, permission: m.permission, activity: m.activity });
  }

  hasPermission(taskId: number): boolean {
    return !!this.meta.get(taskId)?.permission;
  }

  /** Re-reads now (used right after a hook told us something changed). */
  poke(taskId: number) {
    this.tails.get(taskId)?.read(false);
  }

  state(taskId: number): ChatState {
    const tail = this.tails.get(taskId);
    tail?.read(false);
    const m = this.metaOf(taskId);
    return {
      sessionId: m.sessionId,
      items: tail ? tail.parser.items : [],
      context: tail ? tail.parser.context : null,
      permission: m.permission,
      activity: m.activity,
    };
  }

  has(taskId: number) {
    return this.tails.has(taskId);
  }

  drop(taskId: number) {
    this.tails.get(taskId)?.stop();
    this.tails.delete(taskId);
    this.meta.delete(taskId);
  }

  closeAll() {
    for (const t of this.tails.values()) t.stop();
    this.tails.clear();
  }
}

export { describeTool } from './shared/tools.js';
