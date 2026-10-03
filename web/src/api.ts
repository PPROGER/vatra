import type { ChatState, DiffMode, DiffResult, Project, ServerEvent, ServerInfo, Session, SlashCommand, Task } from '../../server/shared/types';

export interface DirListing {
  path: string;
  parent: string | null;
  isGit: boolean;
  entries: { name: string; path: string; isGit: boolean; hidden: boolean }[];
  shortcuts: { label: string; path: string }[];
}

export type ComposerScope = { kind: 'task'; id: number } | { kind: 'project'; id: number };

export interface RepoInspect {
  path: string;
  isGit: boolean;
  root: string | null;
  name: string;
  defaultBranch: string | null;
  suggestedSetup: string | null;
  envFiles: string[];
}

function readToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="vatra-token"]')?.content;
  if (meta) return meta;
  const q = new URLSearchParams(location.search).get('token');
  try {
    if (q) {
      sessionStorage.setItem('vatra-token', q);
      history.replaceState(null, '', location.pathname);
      return q;
    }
    return sessionStorage.getItem('vatra-token') ?? '';
  } catch {
    return q ?? '';
  }
}

export const token = readToken();

export class ApiError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-vatra-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(json?.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  info: () => req<ServerInfo>('GET', '/api/info'),
  projects: () => req<Project[]>('GET', '/api/projects'),
  addProject: (b: { repo_path: string; name?: string; setup_script?: string; env_files?: string[]; merge_mode?: 'pr' | 'merge' }) =>
    req<Project>('POST', '/api/projects', b),
  updateProject: (id: number, b: { name?: string; setup_script?: string | null; env_files?: string[]; default_branch?: string; merge_mode?: 'pr' | 'merge' }) =>
    req<Project>('PATCH', `/api/projects/${id}`, b),
  deleteProject: (id: number) => req<{ ok: true }>('DELETE', `/api/projects/${id}`),
  branches: (id: number) => req<string[]>('GET', `/api/projects/${id}/branches`),
  tasks: () => req<Task[]>('GET', '/api/tasks'),
  task: (id: number) => req<{ task: Task; sessions: Session[] }>('GET', `/api/tasks/${id}`),
  createTask: (projectId: number, b: { title?: string; prompt?: string; base_branch?: string; attachments?: string[] }) =>
    req<Task>('POST', `/api/projects/${projectId}/tasks`, b),
  renameTask: (id: number, title: string) => req<Task>('PATCH', `/api/tasks/${id}`, { title }),
  diff: (id: number, mode: DiffMode) => req<DiffResult>('GET', `/api/tasks/${id}/diff?mode=${mode}`),
  restart: (id: number) => req<Task>('POST', `/api/tasks/${id}/restart`),
  stop: (id: number) => req<Task>('POST', `/api/tasks/${id}/stop`),
  message: (id: number, text: string, attachments: string[] = []) =>
    req<{ delivered: 'typed' | 'relaunch' }>('POST', `/api/tasks/${id}/message`, { text, attachments }),
  keys: (id: number, key: string) => req<{ ok: true }>('POST', `/api/tasks/${id}/keys`, { key }),
  /** Endpoints the composer uses, for an existing task or for a new-task draft in a project. */
  composer: (scope: ComposerScope) => {
    const base = scope.kind === 'task' ? `/api/tasks/${scope.id}` : `/api/projects/${scope.id}`;
    return {
      commands: () => req<SlashCommand[]>('GET', `${base}/commands`),
      files: (q: string) => req<string[]>('GET', `${base}/files?q=${encodeURIComponent(q)}`),
      upload: async (file: File) => {
        const res = await fetch(`${base}/uploads`, {
          method: 'POST',
          headers: { 'x-vatra-token': token, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'paste.png') },
          body: file,
        });
        const json = await res.json();
        if (!res.ok) throw new ApiError(json?.error ?? res.statusText);
        return json as { name: string; path: string; size: number };
      },
      fileUrl: (path: string) => `${base}/uploads/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`,
    };
  },
  chat: (id: number) => req<ChatState>('GET', `/api/tasks/${id}/chat`),
  files: (id: number, q: string) => req<string[]>('GET', `/api/tasks/${id}/files?q=${encodeURIComponent(q)}`),
  commands: (id: number) => req<SlashCommand[]>('GET', `/api/tasks/${id}/commands`),
  upload: async (id: number, file: File) => {
    const res = await fetch(`/api/tasks/${id}/uploads`, {
      method: 'POST',
      headers: { 'x-vatra-token': token, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'paste.png') },
      body: file,
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(json?.error ?? res.statusText);
    return json as { name: string; path: string; size: number };
  },
  uploadUrl: (id: number, path: string) => `/api/tasks/${id}/uploads/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`,
  fsList: (path?: string, hidden = false) => req<DirListing>('GET', `/api/fs/list?path=${encodeURIComponent(path ?? '')}${hidden ? '&hidden=1' : ''}`),
  fsRepos: () => req<{ name: string; path: string }[]>('GET', '/api/fs/repos'),
  fsInspect: (path: string) => req<RepoInspect>('GET', `/api/fs/inspect?path=${encodeURIComponent(path)}`),
  fsPick: (start?: string) => req<{ path: string | null }>('POST', '/api/fs/pick', { start }),
  merge: (id: number, strategy: 'merge' | 'squash', push = false) =>
    req<{ task: Task; conflict?: string[]; message: string; pushed?: boolean }>('POST', `/api/tasks/${id}/merge`, { strategy, push }),
  discard: (id: number) => req<Task>('POST', `/api/tasks/${id}/discard`),
  pr: (id: number) => req<{ url: string | null; created: boolean; manual?: boolean; output: string; task: Task }>('POST', `/api/tasks/${id}/pr`),
  prCheck: (id: number) => req<Task>('POST', `/api/tasks/${id}/pr/check`),
  open: (id: number, app: 'zed' | 'files' | 'terminal') => req<{ ok: true }>('POST', `/api/tasks/${id}/open`, { app }),
};

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** All server events are re-broadcast here so any component can listen. */
export const bus = new EventTarget();

export function onServerEvent(fn: (e: ServerEvent) => void): () => void {
  const h = (ev: Event) => fn((ev as CustomEvent<ServerEvent>).detail);
  bus.addEventListener('ld', h);
  return () => bus.removeEventListener('ld', h);
}

/** Reconnecting subscription to /ws/events. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  let timer: number | undefined;
  const connect = () => {
    ws = new WebSocket(wsUrl('/ws/events'));
    ws.onopen = () => {
      retry = 500;
      onStatus(true);
    };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as ServerEvent;
        onEvent(e);
        bus.dispatchEvent(new CustomEvent('ld', { detail: e }));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (closed) return;
      timer = window.setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
