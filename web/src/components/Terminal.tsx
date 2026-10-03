import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api';

const THEME = {
  background: '#0b0d10',
  foreground: '#e6e8eb',
  cursor: '#fb923c',
  cursorAccent: '#0b0d10',
  selectionBackground: '#fb923c55',
  black: '#1c2027',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d7dc',
  brightBlack: '#5c6370',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

export function Terminal({ taskId, alive }: { taskId: number; alive: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');

  useEffect(() => {
    if (!alive || !host.current) return;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(host.current);

    let ws: WebSocket | null = null;
    let disposed = false;
    let retry: number | undefined;

    const sendResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
    };

    const connect = () => {
      setConn('connecting');
      ws = new WebSocket(wsUrl(`/ws/pty/${taskId}`));
      ws.onopen = () => {
        setConn('open');
        term.reset();
        sendResize();
        term.focus();
      };
      ws.onmessage = (m) => term.write(typeof m.data === 'string' ? m.data : '');
      ws.onclose = (ev) => {
        setConn('closed');
        if (disposed) return;
        // 4404: no live agent; the parent will flip `alive` via the events stream
        if (ev.code !== 4404) retry = window.setTimeout(connect, 1000);
      };
    };

    const input = term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'i', d })));
    // Shift+Enter → newline in the claude prompt (same bytes as Option+Enter)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: '\x1b\r' }));
        return false;
      }
      return true;
    });

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host.current);
    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      ro.disconnect();
      input.dispose();
      ws?.close();
      term.dispose();
    };
  }, [taskId, alive]);

  if (!alive) return null;
  return (
    <div className="relative h-full w-full bg-bg">
      <div ref={host} className="h-full w-full" />
      {conn !== 'open' && (
        <div className="absolute top-2 right-3 text-[11px] text-faint">{conn === 'connecting' ? 'підключення…' : 'відʼєднано'}</div>
      )}
    </div>
  );
}
