import { tr } from './shared/i18n/index.js';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import * as fsapi from './fsapi.js';
import { timingSafeEqual } from 'node:crypto';
import type { WebSocket } from '@fastify/websocket';
import type { TerminalHub } from './pty.js';
import { TaskService, UserError } from './service.js';
import type { DiffMode, ServerEvent, ServerInfo } from './shared/types.js';
import type { OpenTarget } from './platform.js';
import type { MergeStrategy } from './git.js';

export interface AppDeps {
  service: TaskService;
  hub: TerminalHub;
  token: string;
  port: number;
  webDir: string | null;
  dev: boolean;
  info: () => ServerInfo;
  settings: {
    patch: (p: { language?: 'auto' | 'uk' | 'en'; idleSleepMinutes?: number; maxActive?: number }) => Promise<ServerInfo>;
    maintenance: () => Promise<void>;
  };
  subscribe: (fn: (e: ServerEvent) => void) => () => void;
}

function sendUpload(reply: FastifyReply, path: string) {
  const ext = extname(path).toLowerCase();
  const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
  reply.header('content-type', types[ext] ?? 'application/octet-stream');
  reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  return reply.send(createReadStream(path));
}

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.VATRA_LOG_LEVEL ?? process.env.LOCALDELTA_LOG_LEVEL ?? 'warn' },
    bodyLimit: 2 * 1024 * 1024,
  });

  const allowedHosts = new Set([`127.0.0.1:${d.port}`, `localhost:${d.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${d.port}`, `http://localhost:${d.port}`]);
  if (d.dev) {
    for (const h of ['127.0.0.1:5173', 'localhost:5173']) {
      allowedHosts.add(h);
      allowedOrigins.add(`http://${h}`);
    }
  }

  const tokenOf = (req: FastifyRequest) => {
    const h = req.headers['x-vatra-token'];
    if (typeof h === 'string') return h;
    const q = (req.query as Record<string, string> | undefined)?.token;
    return typeof q === 'string' ? q : '';
  };

  // DNS-rebinding and CSRF protection: localhost host header + token on every API/WS call.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) return reply.code(403).send({ error: 'Forbidden host' });
    const url = req.url;
    const origin = req.headers.origin;
    if (origin && (url.startsWith('/api/') || url.startsWith('/ws/')) && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'Forbidden origin' });
    }
    if (url.startsWith('/api/hooks/')) return; // validated with the per-task hook token
    if (url.startsWith('/api/') || url.startsWith('/ws/')) {
      if (!safeEq(tokenOf(req), d.token)) return reply.code(401).send({ error: 'Bad token' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, code: err.code });
    const e = err as { statusCode?: number; validation?: unknown; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: e.message || 'Internal error' });
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  // ------------------------------------------------------------- REST
  const s = d.service;
  const idParam = (req: FastifyRequest) => {
    const n = Number((req.params as { id: string }).id);
    if (!Number.isInteger(n)) throw new UserError('Bad id');
    return n;
  };
  type Body = Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

  app.get('/api/info', async () => d.info());
  app.patch('/api/settings', async (req) => {
    const b = (req.body ?? {}) as Body;
    return d.settings.patch({
      language: str(b.language) as 'auto' | 'uk' | 'en' | undefined,
      idleSleepMinutes: typeof b.idleSleepMinutes === 'number' ? b.idleSleepMinutes : undefined,
      maxActive: typeof b.maxActive === 'number' ? b.maxActive : undefined,
    });
  });
  // run the periodic jobs now: idle sleep, base-branch check, PR status
  app.post('/api/maintenance', async () => {
    await d.settings.maintenance();
    return { ok: true };
  });

  app.get('/api/projects', async () => s.listProjects());
  app.post('/api/projects', async (req) => {
    const b = (req.body ?? {}) as Body;
    if (!str(b.repo_path ?? b.repoPath)) throw new UserError(tr('Потрібен repo_path'));
    return s.addProject({
      repoPath: str(b.repo_path ?? b.repoPath)!,
      name: str(b.name),
      setupScript: str(b.setup_script ?? b.setupScript) ?? null,
      envFiles: Array.isArray(b.env_files ?? b.envFiles) ? ((b.env_files ?? b.envFiles) as string[]) : [],
      defaultBranch: str(b.default_branch ?? b.defaultBranch),
      mergeMode: (str(b.merge_mode ?? b.mergeMode) as 'pr' | 'merge' | undefined) ?? undefined,
    });
  });
  app.patch('/api/projects/:id', async (req) => {
    const b = (req.body ?? {}) as Body;
    const envFiles = b.env_files ?? b.envFiles;
    const setup = b.setup_script ?? b.setupScript;
    return s.updateProject(idParam(req), {
      name: str(b.name),
      setupScript: setup === undefined ? undefined : (str(setup) ?? null),
      envFiles: Array.isArray(envFiles) ? (envFiles as string[]) : undefined,
      defaultBranch: str(b.default_branch ?? b.defaultBranch),
      mergeMode: (str(b.merge_mode ?? b.mergeMode) as 'pr' | 'merge' | undefined) ?? undefined,
    });
  });
  app.delete('/api/projects/:id', async (req) => {
    s.removeProject(idParam(req));
    return { ok: true };
  });
  app.get('/api/projects/:id/branches', async (req) => s.branches(idParam(req)));
  app.get('/api/projects/:id/tasks', async (req) => s.listTasks(idParam(req)));
  app.post('/api/projects/:id/tasks', async (req) => {
    const b = (req.body ?? {}) as Body;
    return s.createTask(idParam(req), {
      title: str(b.title) ?? null,
      prompt: str(b.prompt) ?? null,
      baseBranch: str(b.base_branch ?? b.baseBranch) ?? null,
      attachments: Array.isArray(b.attachments) ? (b.attachments as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    });
  });
  app.get('/api/projects/:id/files', async (req) => s.projectFiles(idParam(req), str((req.query as Body).q) ?? ''));
  app.get('/api/projects/:id/commands', async (req) => s.projectCommands(idParam(req)));
  app.post('/api/projects/:id/uploads', { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    if (!Buffer.isBuffer(req.body)) throw new UserError(tr('Очікується application/octet-stream'));
    return s.saveDraftUpload(idParam(req), name, req.body);
  });
  app.get('/api/projects/:id/uploads/file', async (req, reply) => sendUpload(reply, s.draftUploadPath(idParam(req), str((req.query as Body).path) ?? '')));
  app.patch('/api/tasks/:id', async (req) => s.renameTask(idParam(req), str(((req.body ?? {}) as Body).title) ?? ''));

  app.get('/api/tasks', async () => s.listTasks());
  app.get('/api/tasks/:id', async (req) => ({ task: s.getTask(idParam(req)), sessions: s.sessionsOf(idParam(req)), hooks: s.hookInfo(idParam(req)) }));
  app.get('/api/tasks/:id/diff', async (req) => {
    const mode = ((req.query as Body).mode as DiffMode) ?? 'all';
    if (!['all', 'committed', 'working'].includes(mode)) throw new UserError('mode: all|committed|working');
    return s.diff(idParam(req), mode);
  });
  app.post('/api/tasks/:id/restart', async (req) => s.restart(idParam(req)));
  app.post('/api/tasks/:id/stop', async (req) => s.stop(idParam(req)));
  app.post('/api/tasks/:id/message', async (req) => {
    const b = (req.body ?? {}) as Body;
    const attachments = Array.isArray(b.attachments) ? (b.attachments as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return s.sendMessage(idParam(req), str(b.text) ?? '', attachments);
  });
  app.post('/api/tasks/:id/keys', async (req) => {
    await s.keys(idParam(req), str(((req.body ?? {}) as Body).key) ?? '');
    return { ok: true };
  });
  app.get('/api/tasks/:id/chat', async (req) => s.chatState(idParam(req)));
  app.get('/api/tasks/:id/files', async (req) => s.files(idParam(req), str((req.query as Body).q) ?? ''));
  app.get('/api/tasks/:id/commands', async (req) => s.commands(idParam(req)));
  app.post('/api/tasks/:id/uploads', { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    if (!Buffer.isBuffer(req.body)) throw new UserError(tr('Очікується application/octet-stream'));
    return s.saveUpload(idParam(req), name, req.body);
  });
  app.get('/api/tasks/:id/uploads/file', async (req, reply) => sendUpload(reply, s.uploadPath(idParam(req), str((req.query as Body).path) ?? '')));

  // ------------------------------------------------------------- folder picking
  app.get('/api/fs/list', async (req) => {
    const q = req.query as Body;
    try {
      return fsapi.listDir(str(q.path), q.hidden === '1');
    } catch (err) {
      throw new UserError((err as Error).message);
    }
  });
  app.get('/api/fs/repos', async () => fsapi.scanRepos());
  app.get('/api/fs/inspect', async (req) => fsapi.inspect(str((req.query as Body).path) ?? '~'));
  app.post('/api/fs/pick', async (req) => {
    try {
      return { path: await fsapi.pickFolderNative(str(((req.body ?? {}) as Body).start)) };
    } catch (err) {
      throw new UserError((err as Error).message);
    }
  });
  app.post('/api/tasks/:id/merge', async (req) => {
    const b = (req.body ?? {}) as Body;
    const strategy = (str(b.strategy) ?? 'merge') as MergeStrategy;
    if (!['merge', 'squash'].includes(strategy)) throw new UserError('strategy: merge|squash');
    return s.merge(idParam(req), strategy, { push: b.push === true });
  });
  app.post('/api/tasks/:id/discard', async (req) => s.discard(idParam(req)));
  app.post('/api/tasks/:id/rebase', async (req) => s.rebase(idParam(req)));
  app.post('/api/tasks/:id/finish', async (req) => s.finish(idParam(req), { force: ((req.body ?? {}) as Body).force === true }));
  app.post('/api/tasks/:id/pr', async (req) => s.pr(idParam(req)));
  app.post('/api/tasks/:id/pr/check', async (req) => s.checkPr(idParam(req)));
  app.post('/api/tasks/:id/open', async (req) => {
    const target = (str(((req.body ?? {}) as Body).app) ?? 'files') as OpenTarget;
    if (!['zed', 'files', 'terminal'].includes(target)) throw new UserError('app: zed|files|terminal');
    await s.open(idParam(req), target);
    return { ok: true };
  });

  // Claude Code hooks (curl from inside the worktree)
  app.post('/api/hooks/:id', async (req) => {
    const q = req.query as Body;
    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    await s.onHook(idParam(req), str(q.token) ?? '', str(q.event) ?? '', payload);
    return { ok: true };
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // curl without a body (PaneDied) sends no content-type; accept anything as empty JSON
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch {
      done(null, {});
    }
  });

  // ------------------------------------------------------------- WebSockets
  app.register(async (scope) => {
    scope.get('/ws/events', { websocket: true }, (socket: WebSocket) => {
      const unsub = d.subscribe((e) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
      });
      const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000);
      socket.on('close', () => {
        unsub();
        clearInterval(ping);
      });
    });

    scope.get('/ws/pty/:id', { websocket: true }, (socket: WebSocket, req) => {
      const taskId = Number((req.params as { id: string }).id);
      const client = {
        send: (data: string) => socket.readyState === socket.OPEN && socket.send(data),
        close: (code?: number, reason?: string) => socket.close(code ?? 1000, reason),
      };
      if (!d.hub.addClient(taskId, client)) {
        socket.close(4404, 'agent not running');
        return;
      }
      socket.on('message', (raw: Buffer) => {
        let msg: { t: string; d?: string; c?: number; r?: number };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.t === 'i' && typeof msg.d === 'string') d.hub.write(taskId, msg.d);
        else if (msg.t === 'r' && msg.c && msg.r) d.hub.resize(taskId, msg.c, msg.r);
      });
      socket.on('close', () => d.hub.removeClient(taskId, client));
    });
  });

  // ------------------------------------------------------------- UI
  if (d.webDir && existsSync(join(d.webDir, 'index.html'))) {
    const indexHtml = readFileSync(join(d.webDir, 'index.html'), 'utf8').replace(
      '</head>',
      `<meta name="vatra-token" content="${d.token}"></head>`,
    );
    await app.register(fastifyStatic, { root: d.webDir, index: false, wildcard: false, prefix: '/' });
    const sendIndex = (_req: FastifyRequest, reply: import('fastify').FastifyReply) =>
      reply.header('cache-control', 'no-store').type('text/html').send(indexHtml);
    app.get('/', sendIndex);
    app.get('/assets/*', (req, reply) => reply.sendFile((req.params as { '*': string })['*'], join(d.webDir!, 'assets')));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ error: 'Not found' });
      return sendIndex(req, reply);
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          d.dev
            ? `<p>Dev mode: open <a href="http://localhost:5173/?token=${d.token}">http://localhost:5173/?token=…</a></p>`
            : `<p>${tr('UI не зібрано. Запусти <code>pnpm build</code>.')}</p>`,
        ),
    );
  }

  return app;
}
