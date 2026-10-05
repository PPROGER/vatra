// The orchestrator: owns task lifecycle, talks to git, tmux, the terminal hub
// and the diff watcher, and is the only place that changes task status.
import { tr } from './shared/i18n/index.js';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Config, Paths } from './config.js';
import { now, projects, sessions, tasks, toProject, toSession, toTask, type DB, type TaskRow } from './db.js';
import * as git from './git.js';
import { SETTINGS_REL, curlPost, hookTrace, hookUrl, writeHooks } from './hooks.js';
import { envVar, notify, openIn, type OpenTarget } from './platform.js';
import type { TerminalHub } from './pty.js';
import type { AgentQuestion, ChatState, DiffMode, QuestionAnswer, DiffResult, Project, ServerEvent, Session, SlashCommand, Task, TaskStatus } from './shared/types.js';
import { describeTool, type ChatHub } from './transcript.js';
import { inheritTrust } from './claudetrust.js';
import { findTranscript, screenAsksPermission, turnState } from './turnstate.js';
import { listSlashCommands } from './commands.js';
import { CLOSED_STATUSES, OPEN_STATUSES, SETTLED_STATUSES } from './shared/types.js';
import { slugify, uniqueSlug } from './slug.js';
import { shQuote, Tmux } from './tmux.js';
import type { DiffWatcher } from './watcher.js';

export class UserError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    /** Machine-readable reason for the UI, independent of the message language. */
    public readonly code?: string,
  ) {
    super(message);
  }
}

export interface ServiceDeps {
  db: DB;
  paths: Paths;
  config: Config;
  tmux: Tmux;
  hub: TerminalHub;
  watcher: DiffWatcher;
  emit: (e: ServerEvent) => void;
  claudeBin: string | null;
  pathEnv: string | null;
  chat: ChatHub;
  log?: (msg: string) => void;
}

const LIVE: TaskStatus[] = ['running', 'idle'];
/** How long to wait for claude's first hook before falling back to reading its transcript. */
const HOOK_GRACE_MS = 8000;

export class TaskService {
  private locks = new Map<string, Promise<unknown>>();
  private dequeuing = false;

  private screen = new Map<number, string>();
  private trustAsked = new Set<string>();

  constructor(private readonly d: ServiceDeps) {
    // Claude asks whether to trust a new folder before it loads hooks, so the chat
    // can only learn about it from the screen.
    d.hub.onOutput = (taskId, chunk) => {
      const text = ((this.screen.get(taskId) ?? '') + stripTerm(chunk)).slice(-4000);
      this.screen.set(taskId, text);
      if (!/do\s*you\s*trust\s*the\s*files|trust\s*this\s*folder/i.test(text)) return;
      const key = `${taskId}:${this.lastSession(taskId)?.id ?? 0}`;
      if (this.trustAsked.has(key)) return;
      this.trustAsked.add(key);
      this.screen.set(taskId, '');
      this.d.chat.setMeta(taskId, {
        permission: { kind: 'trust', tool: null, message: tr('Claude вперше бачить цю папку (worktree задачі) і питає, чи довіряти її файлам.') },
      });
    };
  }

  private log(msg: string) {
    (this.d.log ?? console.log)(msg);
  }

  /** Serialises git operations per repository (worktree add/remove, merge). */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  // ------------------------------------------------------------- projects

  listProjects(): Project[] {
    return this.d.db.select().from(projects).all().map(toProject);
  }

  getProject(id: number): Project {
    const r = this.d.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!r) throw new UserError(tr('Проєкт не знайдено'), 404);
    return toProject(r);
  }

  async addProject(input: {
    repoPath: string;
    name?: string;
    setupScript?: string | null;
    envFiles?: string[];
    defaultBranch?: string;
    mergeMode?: 'pr' | 'merge';
  }): Promise<Project> {
    const raw = input.repoPath.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
    const root = await git.repoRoot(raw);
    const existing = this.d.db.select().from(projects).where(eq(projects.repoPath, root)).get();
    if (existing) throw new UserError(tr('Проєкт уже додано: {name}', { name: existing.name }), 409);
    const defaultBranch = input.defaultBranch?.trim() || (await git.detectDefaultBranch(root));
    const row = this.d.db
      .insert(projects)
      .values({
        name: input.name?.trim() || basename(root),
        repoPath: root,
        defaultBranch,
        setupScript: input.setupScript?.trim() || null,
        envFiles: JSON.stringify(cleanEnvFiles(input.envFiles)),
        mergeMode: input.mergeMode === 'merge' ? 'merge' : 'pr',
        createdAt: now(),
      })
      .returning()
      .get();
    const p = toProject(row);
    this.d.emit({ type: 'project', project: p });
    return p;
  }

  updateProject(id: number, patch: { name?: string; setupScript?: string | null; envFiles?: string[]; defaultBranch?: string; mergeMode?: 'pr' | 'merge' }): Project {
    this.getProject(id);
    const values: Partial<typeof projects.$inferInsert> = {};
    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.setupScript !== undefined) values.setupScript = patch.setupScript?.trim() || null;
    if (patch.envFiles !== undefined) values.envFiles = JSON.stringify(cleanEnvFiles(patch.envFiles));
    if (patch.defaultBranch !== undefined) values.defaultBranch = patch.defaultBranch.trim();
    if (patch.mergeMode === 'pr' || patch.mergeMode === 'merge') values.mergeMode = patch.mergeMode;
    if (Object.keys(values).length) this.d.db.update(projects).set(values).where(eq(projects.id, id)).run();
    const p = this.getProject(id);
    this.d.emit({ type: 'project', project: p });
    return p;
  }

  removeProject(id: number): void {
    this.getProject(id);
    const open = this.d.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, id), inArray(tasks.status, [...OPEN_STATUSES])))
      .all();
    if (open.length) throw new UserError(tr('Спочатку заверши або відкинь відкриті задачі ({count})', { count: open.length }), 409);
    const ids = this.d.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, id)).all().map((r) => r.id);
    if (ids.length) {
      this.d.db.delete(sessions).where(inArray(sessions.taskId, ids)).run();
      this.d.db.delete(tasks).where(inArray(tasks.id, ids)).run();
    }
    this.d.db.delete(projects).where(eq(projects.id, id)).run();
    this.d.emit({ type: 'project_removed', projectId: id });
  }

  async branches(projectId: number): Promise<string[]> {
    return git.listBranches(this.getProject(projectId).repoPath);
  }

  // ------------------------------------------------------------- tasks: read

  private row(id: number): TaskRow {
    const r = this.d.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!r) throw new UserError(tr('Задачу не знайдено'), 404);
    return r;
  }

  private dto(r: TaskRow): Task {
    const base = this.baseAhead.get(r.id);
    return toTask(r, { alive: this.d.hub.has(r.id), baseAhead: base?.count ?? null, baseRef: base?.ref ?? null });
  }

  getTask(id: number): Task {
    return this.dto(this.row(id));
  }

  listTasks(projectId?: number): Task[] {
    const q = this.d.db.select().from(tasks);
    const rows = projectId ? q.where(eq(tasks.projectId, projectId)).orderBy(desc(tasks.id)).all() : q.orderBy(desc(tasks.id)).all();
    return rows.map((r) => this.dto(r));
  }

  sessionsOf(taskId: number): Session[] {
    return this.d.db.select().from(sessions).where(eq(sessions.taskId, taskId)).orderBy(desc(sessions.id)).all().map(toSession);
  }

  private lastSession(taskId: number) {
    return this.d.db.select().from(sessions).where(eq(sessions.taskId, taskId)).orderBy(desc(sessions.id)).limit(1).get();
  }

  private update(id: number, values: Partial<typeof tasks.$inferInsert>): Task {
    if (values.status) {
      if (values.status !== 'idle') this.idleSince.delete(id);
      else if (!this.idleSince.has(id)) this.idleSince.set(id, Date.now());
    }
    this.d.db.update(tasks).set(values).where(eq(tasks.id, id)).run();
    const t = this.getTask(id);
    this.d.emit({ type: 'task', task: t });
    return t;
  }

  private setStatus(id: number, status: TaskStatus, reason: string | null = null): Task {
    return this.update(id, { status, statusReason: reason });
  }

  // ------------------------------------------------------------- tasks: create

  async createTask(
    projectId: number,
    input: { title?: string | null; prompt?: string | null; baseBranch?: string | null; attachments?: string[] },
  ): Promise<Task> {
    const project = this.getProject(projectId);
    const drafts = (input.attachments ?? []).filter((p) => this.isDraftUpload(projectId, p));
    const title = input.title?.trim() || titleFromPrompt(input.prompt ?? '') || (drafts.length ? tr('Задача з файлами') : '');
    if (!title) throw new UserError(tr('Напиши, що треба зробити'));
    const baseBranch = input.baseBranch?.trim() || project.defaultBranch;
    if (!(await git.branchExists(project.repoPath, baseBranch))) throw new UserError(tr('Гілки {branch} немає', { branch: baseBranch }));

    const projectDir = join(this.d.paths.worktreesDir, safeDirName(project.name, project.id));
    const slug = await uniqueSlug(slugify(title), async (s) => {
      const inDb = this.d.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(tasks.slug, s)))
        .get();
      return !!inDb || existsSync(join(projectDir, s)) || (await git.branchExists(project.repoPath, `agent/${s}`));
    });

    const row = this.d.db
      .insert(tasks)
      .values({
        projectId,
        title,
        slug,
        prompt: input.prompt?.trim() || null,
        branch: `agent/${slug}`,
        baseBranch,
        baseCommit: null,
        worktreePath: join(projectDir, slug),
        status: 'creating',
        port: this.allocatePort(),
        hookToken: randomBytes(16).toString('hex'),
        createdAt: now(),
      })
      .returning()
      .get();
    if (drafts.length) {
      // files attached in the "new task" chat move into the task's own upload folder
      const dir = this.uploadDir(row.id);
      mkdirSync(dir, { recursive: true });
      const moved = drafts.map((p) => {
        const dst = join(dir, basename(p));
        renameSync(p, dst);
        return dst;
      });
      const prompt = withAttachments(row.prompt ?? '', moved);
      this.d.db.update(tasks).set({ prompt }).where(eq(tasks.id, row.id)).run();
      row.prompt = prompt;
    }
    this.d.emit({ type: 'task', task: this.dto(row) });

    void this.provision(row.id).catch((err) => {
      this.log(`[task ${row.id}] create failed: ${(err as Error).message}`);
      this.setStatus(row.id, 'error', (err as Error).message);
    });
    return this.dto(row);
  }

  private allocatePort(): number | null {
    const [lo, hi] = this.d.config.portRange;
    const used = new Set(
      this.d.db
        .select({ port: tasks.port })
        .from(tasks)
        .where(inArray(tasks.status, [...OPEN_STATUSES]))
        .all()
        .map((r) => r.port),
    );
    for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
    return null;
  }

  private async provision(taskId: number): Promise<void> {
    const t = this.row(taskId);
    const project = this.getProject(t.projectId);
    const repo = project.repoPath;

    await this.withLock(repo, async () => {
      const fetchErr = await git.fetchQuiet(repo);
      if (fetchErr) this.log(`[task ${taskId}] git fetch: ${fetchErr}`);
      const baseCommit = await git.revParse(repo, t.baseBranch);
      this.update(taskId, { baseCommit });
      await git.addWorktree(repo, t.worktreePath, t.branch, baseCommit);
    });

    const excludes = [SETTINGS_REL];
    for (const f of project.envFiles) {
      const src = join(repo, f);
      const dst = join(t.worktreePath, f);
      if (!existsSync(src) || !statSync(src).isFile()) {
        this.log(`[task ${taskId}] env file missing, skipped: ${f}`);
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      excludes.push('/' + f);
    }
    await git.addExcludes(t.worktreePath, excludes);

    this.setStatus(taskId, 'queued');
    await this.dequeue();
  }

  // ------------------------------------------------------------- agent sessions

  private activeCount(): number {
    return this.d.db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.status, LIVE)).all().length;
  }

  /** Starts queued tasks while there is capacity. */
  async dequeue(): Promise<void> {
    if (this.dequeuing) return;
    this.dequeuing = true;
    try {
      for (;;) {
        if (this.activeCount() >= this.d.config.maxActive) return;
        const next = this.d.db.select().from(tasks).where(eq(tasks.status, 'queued')).orderBy(tasks.id).limit(1).get();
        if (!next) return;
        const pending = this.pendingMessages.get(next.id);
        this.pendingMessages.delete(next.id);
        try {
          await this.launch(next.id, { initialMessage: pending });
        } catch (err) {
          this.setStatus(next.id, 'error', tr('Не вдалося запустити агента: {error}', { error: (err as Error).message }));
        }
      }
    } finally {
      this.dequeuing = false;
    }
  }

  private pendingMessages = new Map<number, string>();
  private idleSince = new Map<number, number>();
  private baseAhead = new Map<number, { count: number; ref: string }>();
  private startsWithPrompt = new Set<number>();
  private lastTool = new Map<number, string>();

  private launching = new Set<number>();

  private async launch(taskId: number, opts: { initialMessage?: string } = {}): Promise<void> {
    this.launching.add(taskId);
    try {
      await this.launchInner(taskId, opts);
    } finally {
      this.launching.delete(taskId);
    }
  }

  private async launchInner(taskId: number, opts: { initialMessage?: string }): Promise<void> {
    const t = this.row(taskId);
    const project = this.getProject(t.projectId);
    if (!this.d.claudeBin) throw new Error(tr('claude CLI не знайдено. Встанови Claude Code або задай claudeBin у config.json'));
    if (!existsSync(t.worktreePath)) throw new Error(tr('Worktree не існує: {path}', { path: t.worktreePath }));

    const name = Tmux.sessionName(taskId);
    const pane = await this.d.tmux.pane(name);
    if (pane.exists && !pane.dead) {
      // already running (e.g. double click); just make sure we're attached
      this.d.hub.ensure(taskId, name);
      this.setStatus(taskId, 'running');
      return;
    }
    if (pane.exists) await this.d.tmux.kill(name);

    try {
      if (inheritTrust(project.repoPath, t.worktreePath)) this.log(`[task ${taskId}] claude already trusts ${project.repoPath} — trusting its worktree too`);
    } catch (e) {
      this.log(`[task ${taskId}] could not update ~/.claude.json: ${(e as Error).message}`);
    }
    const flagSettings = writeHooks(t.worktreePath, this.d.config.port, taskId, t.hookToken, this.d.paths.runDir);
    const trace = hookTrace(this.d.paths.runDir, taskId);
    for (const f of [trace.ranFile, trace.logFile, trace.startedFile]) rmSync(f, { force: true });

    const previous = this.lastSession(taskId);
    const isFirst = !previous;
    const args = [...(flagSettings ? ['--settings', flagSettings] : []), ...this.d.config.claudeArgs];
    if (!isFirst) {
      if (previous.claudeSessionId) args.push('--resume', previous.claudeSessionId);
      else args.push('--continue');
    }
    const firstMessage = isFirst ? (t.prompt ?? undefined) : undefined;
    const message = opts.initialMessage ?? firstMessage;
    if (message) args.push(message);
    // claude will start working on this prompt right after SessionStart — don't flash "idle"
    if (message && !message.trimStart().startsWith('/')) this.startsWithPrompt.add(taskId);
    else this.startsWithPrompt.delete(taskId);

    const port = t.port ?? this.allocatePort();
    const sessionRow = this.d.db
      .insert(sessions)
      .values({ taskId, startedAt: now(), logPath: null })
      .returning()
      .get();
    const logPath = join(this.d.paths.logsDir, `task-${taskId}-session-${sessionRow.id}.log`);

    const script = buildLauncher({
      cwd: t.worktreePath,
      claudeBin: this.d.claudeBin,
      args,
      env: {
        PORT: port ? String(port) : undefined,
        VATRA_TASK_ID: String(taskId),
        VATRA_BRANCH: t.branch,
        COLORTERM: 'truecolor',
        PATH: this.d.pathEnv ?? undefined,
      },
      setupScript: isFirst ? project.setupScript : null,
      // checks that the hook endpoint is reachable from the agent's environment (see `vatra selftest`)
      probe: [
        `touch ${shQuote(trace.startedFile)}`,
        `${curlPost(hookUrl(this.d.config.port, taskId, t.hookToken, 'Probe'), '{}')} >/dev/null 2>&1 || echo "$(date '+%F %T') probe curl exit $?" >> ${shQuote(trace.logFile)}`,
      ].join('\n'),
    });
    const scriptPath = join(this.d.paths.runDir, `task-${taskId}.sh`);
    writeFileSync(scriptPath, script, { mode: 0o700 });

    // Status first: the agent's SessionStart hook can arrive before newSession() returns.
    this.update(taskId, { status: 'running', statusReason: null, port, lastMessage: null });
    const pid = await this.d.tmux.newSession({ name, cwd: t.worktreePath, command: ['/bin/sh', scriptPath] });
    const died = `${curlPost(hookUrl(this.d.config.port, taskId, t.hookToken, 'PaneDied'), '{}')} >/dev/null 2>&1 || true`;
    await this.d.tmux.onPaneDied(name, died).catch((e) => this.log(`[task ${taskId}] set-hook: ${e.message}`));
    await this.d.tmux.pipeToFile(name, logPath).catch((e) => this.log(`[task ${taskId}] pipe-pane: ${e.message}`));

    this.d.db.update(sessions).set({ pid, logPath }).where(eq(sessions.id, sessionRow.id)).run();
    this.d.hub.ensure(taskId, name);
    await this.watch(taskId);
    this.d.emit({ type: 'task', task: this.getTask(taskId) }); // alive flag changed
    this.log(`[task ${taskId}] agent started in ${name} (pid ${pid})`);
  }

  private async watch(taskId: number) {
    const t = this.row(taskId);
    if (!existsSync(t.worktreePath)) return;
    const gd = await git.gitDir(t.worktreePath).catch(() => null);
    this.d.watcher.watch(taskId, t.worktreePath, gd);
  }

  /** Records the end of the current session after the agent process exited. */
  private async finalizeSession(taskId: number, exitCode: number | null) {
    const last = this.lastSession(taskId);
    if (last && !last.endedAt) {
      this.d.db.update(sessions).set({ endedAt: now(), exitCode }).where(eq(sessions.id, last.id)).run();
    }
    this.d.hub.close(taskId, 'agent exited');
    this.d.chat.setMeta(taskId, { permission: null, activity: null });
    await this.d.tmux.kill(Tmux.sessionName(taskId));
    const t = this.row(taskId);
    if (LIVE.includes(t.status)) {
      this.setStatus(taskId, 'review', exitCode && exitCode !== 0 ? tr('claude завершився з кодом {code}', { code: exitCode }) : null);
    } else {
      this.d.emit({ type: 'task', task: this.dto(t) });
    }
    await this.dequeue();
  }

  async restart(taskId: number): Promise<Task> {
    const t = this.row(taskId);
    if (!OPEN_STATUSES.includes(t.status) || t.status === 'creating') throw new UserError(tr('Неможливо перезапустити задачу в стані {status}', { status: t.status }));
    if (!existsSync(t.worktreePath)) throw new UserError(tr('Worktree зник — задачу можна лише відкинути'));
    await this.stopAgent(taskId, { keepStatus: true });
    this.setStatus(taskId, 'queued');
    await this.dequeue();
    return this.getTask(taskId);
  }

  async stop(taskId: number): Promise<Task> {
    await this.stopAgent(taskId, { keepStatus: false });
    return this.getTask(taskId);
  }

  private async stopAgent(taskId: number, opts: { keepStatus: boolean }) {
    this.launching.add(taskId); // keep sweep() away while we stop it ourselves
    try {
      await this.stopAgentInner(taskId, opts);
    } finally {
      this.launching.delete(taskId);
    }
  }

  private async stopAgentInner(taskId: number, opts: { keepStatus: boolean }) {
    const name = Tmux.sessionName(taskId);
    this.d.hub.close(taskId, 'agent stopped');
    const p = await this.d.tmux.pane(name);
    await this.d.tmux.clearPaneDied(name);
    await this.d.tmux.stop(name);
    const last = this.lastSession(taskId);
    if (last && !last.endedAt) {
      this.d.db
        .update(sessions)
        .set({ endedAt: now(), exitCode: p.exitCode })
        .where(eq(sessions.id, last.id))
        .run();
    }
    const t = this.row(taskId);
    if (!opts.keepStatus && (LIVE.includes(t.status) || t.status === 'queued')) this.setStatus(taskId, 'review');
    if (!opts.keepStatus) await this.dequeue();
  }

  /**
   * Sends a chat message (or slash command, or `!bash`) to the agent.
   * Attachments are referenced by absolute path so claude reads them with its own tools.
   * If the agent is not running it is relaunched with --resume and the message as prompt.
   */
  async sendMessage(taskId: number, text: string, attachments: string[] = []): Promise<{ delivered: 'typed' | 'relaunch' }> {
    const t = this.row(taskId);
    const files = attachments.filter((p) => this.isUpload(taskId, p));
    if (!text.trim() && !files.length) throw new UserError(tr('Порожнє повідомлення'));
    if (!OPEN_STATUSES.includes(t.status) || t.status === 'creating') throw new UserError(tr('Задача в стані {status}', { status: t.status }));
    let full = text.trim();
    if (files.length) full = withAttachments(full, files);
    const name = Tmux.sessionName(taskId);
    const p = await this.d.tmux.pane(name);
    if (p.exists && !p.dead) {
      await this.d.tmux.sendText(name, full, this.d.paths.runDir);
      this.d.chat.setMeta(taskId, { permission: null });
      return { delivered: 'typed' };
    }
    this.pendingMessages.set(taskId, full);
    this.setStatus(taskId, 'queued');
    await this.dequeue();
    return { delivered: 'relaunch' };
  }

  /** Presses keys in the agent's TUI: answering permission prompts, interrupting, mode switching. */
  async keys(taskId: number, key: string): Promise<void> {
    const map: Record<string, string[]> = {
      enter: ['Enter'],
      escape: ['Escape'],
      interrupt: ['Escape'],
      'allow': ['Enter'],
      'allow-always': ['Down', 'Enter'],
      'deny': ['Escape'],
      'mode': ['BTab'],
      up: ['Up'],
      down: ['Down'],
      tab: ['Tab'],
      'ctrl-c': ['C-c'],
    };
    for (let i = 1; i <= 9; i++) map[String(i)] = [String(i)];
    let seq = map[key];
    if (!seq) throw new UserError(tr('Невідома клавіша: {key}', { key }));
    const name = Tmux.sessionName(taskId);
    const p = await this.d.tmux.pane(name);
    if (!p.exists || p.dead) throw new UserError(tr('Агент не запущений'), 409);
    if (key === 'allow' && this.d.chat.permissionKind(taskId) === 'trust') {
      // newer claude lists "No, exit" first and "Yes, I trust this folder" second
      const screen = await this.d.tmux.capture(name).catch(() => '');
      if (/No,\s*exit[\s\S]*Yes,\s*I\s*trust/i.test(screen)) seq = ['Down', 'Enter'];
    }
    await this.d.tmux.sendKeys(name, seq);
    if (['allow', 'allow-always', 'deny', 'escape', 'interrupt'].includes(key)) this.d.chat.setMeta(taskId, { permission: null });
  }

  /**
   * Answers claude's AskUserQuestion dialog by driving its TUI: a digit picks an option
   * (single choice moves on by itself), digits toggle options of a multi-choice question
   * and Tab moves on, "Type something" takes free text + Enter; with more than one
   * question (or any multi-choice) a review screen follows, where "1" submits.
   */
  private answering = new Set<string>();

  /** claude is waiting in its AskUserQuestion dialog. */
  hasOpenQuestion(taskId: number): boolean {
    if (!this.d.chat.has(taskId)) return false;
    return this.d.chat.state(taskId).items.some((i) => i.kind === 'tool' && i.name === 'AskUserQuestion' && !i.done);
  }

  async answerQuestion(taskId: number, toolId: string, answers: QuestionAnswer[]): Promise<void> {
    const item = this.chatState(taskId).items.find((i) => i.kind === 'tool' && i.id === toolId);
    if (!item || item.kind !== 'tool' || item.name !== 'AskUserQuestion') throw new UserError(tr('Питання не знайдено'), 404);
    if (item.done) throw new UserError(tr('На це питання вже відповіли'), 409);
    const questions = (Array.isArray(item.input.questions) ? item.input.questions : []) as AgentQuestion[];
    if (!questions.length || answers.length !== questions.length) throw new UserError(tr('Дай відповідь на кожне питання'));
    const name = Tmux.sessionName(taskId);
    const p = await this.d.tmux.pane(name);
    if (!p.exists || p.dead) throw new UserError(tr('Агент не запущений'), 409);

    // validate everything before touching the dialog
    const plan = questions.map((q, qi) => {
      const a = answers[qi];
      const n = Array.isArray(q.options) ? q.options.length : 0;
      const picked = [...new Set((a?.selected ?? []).filter((k) => Number.isInteger(k) && k >= 0 && k < n))];
      const other = (a?.other ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (q.multiSelect && !picked.length) throw new UserError(tr('Обери хоча б один варіант: {q}', { q: q.question }));
      if (!q.multiSelect && !other && picked.length !== 1) throw new UserError(tr('Обери один варіант: {q}', { q: q.question }));
      return { q, n, picked, other };
    });
    if (this.answering.has(`${taskId}:${toolId}`)) throw new UserError(tr('На це питання вже відповіли'), 409);
    this.answering.add(`${taskId}:${toolId}`);
    setTimeout(() => this.answering.delete(`${taskId}:${toolId}`), 30_000);
    // status first: claude's next hooks can arrive while the keys are still being sent
    this.update(taskId, { status: 'running', lastMessage: null });
    this.d.chat.setMeta(taskId, { activity: tr('Думає…') });

    const tm = this.d.tmux;
    for (const { q, n, picked, other } of plan) {
      if (q.multiSelect) {
        await tm.sendKeys(name, picked.map((k) => String(k + 1)), 180);
        await tm.sendKeys(name, ['Tab'], 250);
      } else if (other) {
        await tm.sendKeys(name, [String(n + 1)], 200);
        await tm.typeLiteral(name, other);
        await tm.sendKeys(name, ['Enter'], 250);
      } else {
        await tm.sendKeys(name, [String(picked[0] + 1)], 250);
      }
    }
    if (questions.length > 1 || questions.some((q) => q.multiSelect)) await tm.sendKeys(name, ['1'], 100);
  }

  // ------------------------------------------------------------- chat helpers

  chatState(taskId: number): ChatState {
    this.row(taskId);
    if (!this.d.chat.has(taskId)) {
      const withTranscript = this.d.db
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, taskId))
        .orderBy(desc(sessions.id))
        .all()
        .find((s) => s.transcriptPath);
      if (withTranscript?.transcriptPath) this.d.chat.follow(taskId, withTranscript.transcriptPath, withTranscript.claudeSessionId);
    }
    return this.d.chat.state(taskId);
  }

  private uploadDir(taskId: number) {
    return join(this.d.paths.uploadsDir, `task-${taskId}`);
  }

  private isUpload(taskId: number, p: string) {
    const dir = this.uploadDir(taskId) + '/';
    return typeof p === 'string' && p.startsWith(dir) && !p.includes('..') && existsSync(p);
  }

  private draftDir(projectId: number) {
    return join(this.d.paths.uploadsDir, 'drafts', `project-${projectId}`);
  }

  private isDraftUpload(projectId: number, p: string) {
    const dir = this.draftDir(projectId) + '/';
    return typeof p === 'string' && p.startsWith(dir) && !p.includes('..') && existsSync(p);
  }

  /** Files attached while composing a new task (before it exists). */
  saveDraftUpload(projectId: number, rawName: string, data: Buffer) {
    this.getProject(projectId);
    return this.writeUpload(this.draftDir(projectId), rawName, data);
  }

  draftUploadPath(projectId: number, p: string): string {
    if (!this.isDraftUpload(projectId, p)) throw new UserError(tr('Файл не знайдено'), 404);
    return p;
  }

  /** @-mentions and slash commands for the "new task" composer, from the main checkout. */
  async projectFiles(projectId: number, q: string): Promise<string[]> {
    const p = this.getProject(projectId);
    const r = await git.run(p.repoPath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const files = [...new Set(r.stdout.split('\0').filter(Boolean))];
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }
    return fuzzyFilter([...dirs, ...files], q, 40);
  }

  projectCommands(projectId: number): SlashCommand[] {
    return listSlashCommands(this.getProject(projectId).repoPath);
  }

  renameTask(taskId: number, title: string): Task {
    this.row(taskId);
    const t = title.trim();
    if (!t) throw new UserError(tr('Порожня назва'));
    return this.update(taskId, { title: t.slice(0, 200) });
  }

  saveUpload(taskId: number, rawName: string, data: Buffer): { name: string; path: string; size: number } {
    this.row(taskId);
    return this.writeUpload(this.uploadDir(taskId), rawName, data);
  }

  private writeUpload(dir: string, rawName: string, data: Buffer): { name: string; path: string; size: number } {
    if (!data.length) throw new UserError(tr('Порожній файл'));
    const clean = basename(rawName || 'file').replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(-120) || 'file';
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const path = join(dir, `${stamp}-${randomBytes(2).toString('hex')}-${clean}`);
    writeFileSync(path, data);
    return { name: clean, path, size: data.length };
  }

  /** Absolute path of an uploaded file if it belongs to the task (for previews). */
  uploadPath(taskId: number, p: string): string {
    if (!this.isUpload(taskId, p)) throw new UserError(tr('Файл не знайдено'), 404);
    return p;
  }

  private fileCache = new Map<number, { at: number; files: string[] }>();

  /** Repo files for @-mentions, fuzzy-filtered. */
  async files(taskId: number, q: string): Promise<string[]> {
    const t = this.row(taskId);
    if (!existsSync(t.worktreePath)) return [];
    let cached = this.fileCache.get(taskId);
    if (!cached || Date.now() - cached.at > 10_000) {
      const r = await git.run(t.worktreePath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
      const files = [...new Set(r.stdout.split('\0').filter(Boolean))];
      const dirs = new Set<string>();
      for (const f of files) {
        const parts = f.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
      }
      cached = { at: Date.now(), files: [...dirs, ...files] };
      this.fileCache.set(taskId, cached);
    }
    return fuzzyFilter(cached.files, q, 40);
  }

  /** Slash commands: built-ins plus project/user custom commands and skills. */
  commands(taskId: number): SlashCommand[] {
    const t = this.row(taskId);
    return listSlashCommands(t.worktreePath);
  }

    // ------------------------------------------------------------- hooks

  private hookStats = new Map<number, { count: number; last: string | null; at: string | null; rejected: number }>();

  /** Diagnostics: how many hook calls arrived for a task (used by `vatra selftest`). */
  hookInfo(taskId: number) {
    return this.hookStats.get(taskId) ?? { count: 0, last: null, at: null, rejected: 0 };
  }

  async onHook(taskId: number, token: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const t = this.d.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const stats = this.hookInfo(taskId);
    this.hookStats.set(taskId, stats);
    if (!t || t.hookToken !== token) {
      stats.rejected++;
      this.log(`[task ${taskId}] rejected hook ${event}: bad token`);
      throw new UserError(tr('Невірний hook token'), 403);
    }
    stats.count++;
    stats.last = event;
    stats.at = now();
    if (event === 'Probe') return; // reachability check from the launcher / selftest
    if (event !== 'PaneDied') {
      const last = this.lastSession(taskId);
      if (last && !last.endedAt) this.hooked.set(taskId, last.id);
    }
    await this.applyEvent(taskId, event, payload);
  }

  /** Applies one Claude Code lifecycle event — from a hook, or inferred when hooks don't work. */
  private async applyEvent(taskId: number, event: string, payload: Record<string, unknown>): Promise<void> {
    const t = this.d.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!t) return;

    const sid = typeof payload.session_id === 'string' ? payload.session_id : null;
    const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
    if (sid || transcript) {
      const last = this.lastSession(taskId);
      if (last && !last.endedAt && (last.claudeSessionId !== sid || last.transcriptPath !== transcript)) {
        this.d.db
          .update(sessions)
          .set({ claudeSessionId: sid ?? last.claudeSessionId, transcriptPath: transcript ?? last.transcriptPath })
          .where(eq(sessions.id, last.id))
          .run();
      }
      // /clear starts a new transcript file: the chat follows it
      if (transcript) this.d.chat.follow(taskId, transcript, sid);
    }

    if (event === 'PaneDied') {
      const p = await this.d.tmux.pane(Tmux.sessionName(taskId));
      if (p.exists && !p.dead) return; // stale event: a new session is already running
      const last = this.lastSession(taskId);
      if (!p.exists && (!last || last.endedAt)) return; // already handled by stop()
      await this.finalizeSession(taskId, p.exitCode);
      return;
    }
    if (!LIVE.includes(t.status)) return;

    const chat = this.d.chat;
    switch (event) {
      case 'SessionStart':
        if (this.startsWithPrompt.delete(taskId)) {
          this.update(taskId, { status: 'running', lastMessage: null });
          chat.setMeta(taskId, { permission: null, activity: tr('Думає…') });
        } else {
          this.update(taskId, { status: 'idle', lastMessage: null });
          chat.setMeta(taskId, { permission: null, activity: null });
        }
        break;
      case 'UserPromptSubmit':
        if (t.status !== 'running' || t.lastMessage) this.update(taskId, { status: 'running', lastMessage: null });
        chat.setMeta(taskId, { permission: null, activity: tr('Думає…') });
        break;
      case 'PreToolUse': {
        const tool = typeof payload.tool_name === 'string' ? payload.tool_name : 'tool';
        const desc = describeTool(tool, payload.tool_input as Record<string, unknown>);
        this.lastTool.set(taskId, desc);
        if (tool === 'AskUserQuestion') {
          // claude waits for an answer — the question card is in the chat
          this.update(taskId, { status: 'idle', lastMessage: tr('Агент питає') });
          chat.setMeta(taskId, { activity: null });
          chat.poke(taskId);
          this.alert(taskId, tr('Агент «{title}» питає', { title: t.title }), desc);
          break;
        }
        if (t.status !== 'running' || t.lastMessage) this.update(taskId, { status: 'running', lastMessage: null });
        chat.setMeta(taskId, { activity: desc });
        break;
      }
      case 'PostToolUse':
        if (t.status !== 'running' || t.lastMessage) this.update(taskId, { status: 'running', lastMessage: null });
        chat.setMeta(taskId, { permission: null, activity: tr('Думає…') });
        chat.poke(taskId);
        break;
      case 'Stop': {
        this.update(taskId, { status: 'idle', lastMessage: null });
        void this.refreshBaseAhead({ taskId }).catch(() => {});
        void this.syncBranch(taskId).catch(() => {});
        chat.setMeta(taskId, { permission: null, activity: null });
        chat.poke(taskId);
        this.alert(taskId, tr('Агент «{title}» чекає', { title: t.title }), tr('Завершив хід і чекає на тебе'));
        break;
      }
      case 'Notification': {
        const msg = typeof payload.message === 'string' ? payload.message : tr('Потрібна твоя увага');
        const kind = typeof payload.notification_type === 'string' ? payload.notification_type : '';
        this.update(taskId, { status: 'idle', lastMessage: msg });
        const isPermission = kind === 'permission_prompt' || (!kind && /permission|дозв/i.test(msg));
        if (isPermission) chat.setMeta(taskId, { permission: { message: msg, tool: this.lastTool.get(taskId) ?? null } });
        // idle_prompt repeats the Stop notification a minute later — don't ping twice
        if (kind !== 'idle_prompt') this.alert(taskId, tr('Агент «{title}» чекає', { title: t.title }), msg);
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------- without hooks

  /** taskId → session row that delivered real hooks (then nothing is inferred for it). */
  private hooked = new Map<number, number>();
  /** taskId → session row for which a synthetic SessionStart was applied. */
  private inferredStart = new Map<number, number>();

  /** Whether the current session of a task gets real hooks (for the UI / selftest). */
  hooksWork(taskId: number): boolean | null {
    const s = this.lastSession(taskId);
    if (!s || s.endedAt) return null;
    if (this.hooked.get(taskId) === s.id) return true;
    try {
      return Date.now() - statSync(hookTrace(this.d.paths.runDir, taskId).startedFile).mtimeMs > HOOK_GRACE_MS ? false : null;
    } catch {
      return null;
    }
  }

  /**
   * Fallback for setups where claude never runs our hooks: follows the transcript claude
   * writes in ~/.claude/projects and derives running / idle / permission from it and the screen.
   */
  private async inferWithoutHooks(taskId: number): Promise<void> {
    const s = this.lastSession(taskId);
    if (!s || s.endedAt || this.hooked.get(taskId) === s.id) return;
    // count from the moment claude itself started (the setup script may run long before)
    let started: number;
    try {
      started = statSync(hookTrace(this.d.paths.runDir, taskId).startedFile).mtimeMs;
    } catch {
      return;
    }
    if (Date.now() - started < HOOK_GRACE_MS) return;
    if (this.d.chat.permissionKind(taskId) === 'trust') return; // claude hasn't really started yet

    const file = findTranscript(this.row(taskId).worktreePath, started);
    if (file && file !== s.transcriptPath) {
      const sid = basename(file, '.jsonl');
      this.d.db.update(sessions).set({ transcriptPath: file, claudeSessionId: sid }).where(eq(sessions.id, s.id)).run();
      this.d.chat.follow(taskId, file, sid);
      this.log(`[task ${taskId}] no hooks from claude — following its transcript ${file}`);
    }
    if (this.inferredStart.get(taskId) !== s.id) {
      this.inferredStart.set(taskId, s.id);
      await this.applyEvent(taskId, 'SessionStart', {});
    }
    if (!file) return;
    this.d.chat.poke(taskId);

    const t = this.row(taskId);
    if (!LIVE.includes(t.status)) return;
    const ts = turnState(file);
    if (ts.state === 'running' && ts.tool?.name === 'AskUserQuestion') {
      if (this.lastTool.get(taskId) !== describeTool(ts.tool.name, ts.tool.input) || t.status !== 'idle')
        await this.applyEvent(taskId, 'PreToolUse', { tool_name: ts.tool.name, tool_input: ts.tool.input });
      return;
    }
    if (ts.state === 'running') {
      if (ts.quietMs > 1500 && !this.d.chat.hasPermission(taskId)) {
        const screen = await this.d.tmux.capture(Tmux.sessionName(taskId)).catch(() => '');
        if (screenAsksPermission(screen)) {
          if (ts.tool) this.lastTool.set(taskId, describeTool(ts.tool.name, ts.tool.input));
          await this.applyEvent(taskId, 'Notification', { message: tr('Claude просить дозвіл'), notification_type: 'permission_prompt' });
          return;
        }
      }
      if (t.status !== 'running') await this.applyEvent(taskId, 'UserPromptSubmit', {});
      if (ts.tool) {
        const desc = describeTool(ts.tool.name, ts.tool.input);
        if (desc !== this.lastTool.get(taskId)) await this.applyEvent(taskId, 'PreToolUse', { tool_name: ts.tool.name, tool_input: ts.tool.input });
      }
    } else if (ts.state === 'idle' && t.status === 'running') {
      await this.applyEvent(taskId, 'Stop', {});
    }
  }

  private alert(taskId: number, title: string, body: string) {
    notify(title, body);
    this.d.emit({ type: 'notify', taskId, title, body });
  }

  // ------------------------------------------------------------- diff

  async diff(taskId: number, mode: DiffMode): Promise<DiffResult> {
    const t = this.row(taskId);
    if (!t.baseCommit) throw new UserError(tr('Задача ще створюється'));
    if (!existsSync(t.worktreePath)) throw new UserError(tr('Worktree не існує'), 410);
    const fresh = await this.syncBranch(taskId);
    return git.diff(t.worktreePath, t.baseCommit, fresh.branch, mode);
  }

  // ------------------------------------------------------------- merge / discard / PR

  /**
   * Merges the agent branch into the base branch locally (optionally pushing the base).
   * Works whether or not the base is checked out: if it isn't, a temporary worktree is used,
   * so your current checkout is never switched.
   */
  async merge(
    taskId: number,
    strategy: git.MergeStrategy,
    opts: { push?: boolean } = {},
  ): Promise<{ task: Task; conflict?: string[]; message: string; pushed?: boolean; pushFailed?: boolean }> {
    const t = await this.syncBranch(taskId);
    const project = this.getProject(t.projectId);
    if (!SETTLED_STATUSES.includes(t.status)) {
      throw new UserError(t.status === 'running' ? tr('Агент зараз працює — дочекайся паузи або зупини його') : tr('Неможливо злити задачу в стані {status}', { status: t.status }), 409);
    }
    if (!existsSync(t.worktreePath)) throw new UserError(tr('Worktree не існує'), 410);
    if (!(await git.currentBranch(t.worktreePath))) {
      throw new UserError(tr('У worktree агента відʼєднаний HEAD (detached) — попроси агента перейти на свою гілку або створити нову, і спробуй ще раз.'), 409);
    }
    const repo = project.repoPath;
    const base = t.baseBranch;

    return this.withLock(repo, async () => {
      if (opts.push && !(await git.hasRemote(repo))) throw new UserError(tr('У репозиторію немає remote (origin) — пушити нікуди'), 409);

      // where is the base branch checked out?
      const holder = (await git.listWorktrees(repo)).find((w) => w.branch === base);
      let dir: string;
      let temp: string | null = null;
      if (holder) {
        dir = holder.path;
        const dirty = await git.statusPorcelain(dir, false);
        if (dirty.length) {
          throw new UserError(tr('Гілка {branch} відкрита в {dir} і там є незакомічені зміни ({count} файлів). Закоміть або сховай їх (git stash) і спробуй ще раз.', { branch: base, dir, count: dirty.length }), 409);
        }
      } else {
        temp = join(this.d.paths.runDir, `merge-${taskId}-${Date.now()}`);
        await git.run(repo, ['worktree', 'add', '--quiet', temp, base]);
        dir = temp;
      }

      try {
        await git.commitAll(t.worktreePath, `${t.title}\n\nUncommitted changes committed by Vatra before merge.`);
        const ahead = await git.aheadCount(repo, base, t.branch);
        if (ahead === 0) throw new UserError(tr('У гілці {branch} немає нових комітів відносно {base}', { branch: t.branch, base }), 409);

        if (opts.push) {
          // bring the base up to date with origin first, so the push is a fast-forward
          await git.run(repo, ['fetch', '--quiet', 'origin', base], { okCodes: [0, 1, 128], timeout: 60_000 });
          const remoteRef = `refs/remotes/origin/${base}`;
          if (await git.refExists(dir, remoteRef)) {
            if (!(await git.isAncestor(dir, remoteRef, 'HEAD'))) {
              if (await git.isAncestor(dir, 'HEAD', remoteRef)) {
                await git.run(dir, ['merge', '--ff-only', '--quiet', remoteRef]);
              } else {
                throw new UserError(tr('Локальна {base} і origin/{base} розійшлися. Синхронізуй їх вручну (git pull --rebase) і спробуй ще раз.', { base }), 409);
              }
            }
          }
        }

        const message = strategy === 'squash' ? `${t.title}\n\nSquashed from ${t.branch} by Vatra.` : `Merge ${t.branch}: ${t.title}`;
        const res = await git.merge(dir, t.branch, strategy, message);
        if (!res.ok) {
          const files = res.conflictedFiles;
          const reason = res.conflict
            ? tr('Конфлікт злиття: {files}', { files: files.join(', ') || tr('див. вивід git') })
            : tr('git merge не вдався: {output}', { output: res.output.slice(0, 500) });
          this.setStatus(taskId, 'review', reason);
          if (res.conflict) {
            const ask = files.length
              ? tr('Злиття гілки {branch} у {base} дало конфлікт у файлах: {files}. Зроби rebase на {base} (git rebase {base}), розвʼяжи конфлікти, перевір що все працює і закоміть результат.', { branch: t.branch, base, files: files.join(', ') })
              : tr('Злиття гілки {branch} у {base} дало конфлікт. Зроби rebase на {base} (git rebase {base}), розвʼяжи конфлікти, перевір що все працює і закоміть результат.', { branch: t.branch, base });
            await this.sendMessage(taskId, ask).catch((e) => this.log(`[task ${taskId}] could not message agent: ${e.message}`));
          }
          return { task: this.getTask(taskId), conflict: files, message: reason };
        }

        let pushed = false;
        let pushNote = '';
        if (opts.push) {
          const r = await git.pushBranch(dir, base);
          pushed = r.code === 0;
          if (!pushed) pushNote = tr('Але push не пройшов: {error}', { error: (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') });
        }

        await this.cleanup(taskId, { forceBranchDelete: strategy === 'squash' });
        const task = this.update(taskId, { status: 'merged', statusReason: pushNote || null, mergedAt: now() });
        this.log(`[task ${taskId}] merged (${strategy}) into ${base}${pushed ? ' and pushed' : ''}`);
        return { task, pushed, pushFailed: !!opts.push && !pushed, message: pushed ? tr('Злито в {base} і запушено в origin', { base }) : `${tr('Злито в {base}', { base })}${pushNote ? ' ' + pushNote : ''}` };
      } finally {
        if (temp) await git.removeWorktree(repo, temp).catch(() => {});
      }
    });
  }

  /**
   * Closes a task you finished yourself (e.g. the agent pushed from the chat):
   * stops the agent, removes the worktree, archives the chat. The branch is kept
   * unless it is already on origin or merged into the base, so no work is lost.
   */
  async finish(taskId: number, opts: { force?: boolean } = {}): Promise<{ task: Task; message: string; note: string }> {
    const t = await this.syncBranch(taskId);
    if (!OPEN_STATUSES.includes(t.status) || t.status === 'creating') throw new UserError(tr('Задача вже закрита'), 409);
    const project = this.getProject(t.projectId);
    const repo = project.repoPath;
    const hasWt = existsSync(t.worktreePath);

    if (hasWt && !opts.force) {
      const dirty = await git.statusPorcelain(t.worktreePath);
      if (dirty.length) {
        throw new UserError(tr('У worktree є незакомічені зміни ({count} файлів) — вони пропадуть. Закоміть їх через агента або підтверди завершення.', { count: dirty.length }), 409, 'uncommitted');
      }
    }

    return this.withLock(repo, async () => {
      // what happens to the branch: delete only if nothing would be lost
      await git.run(repo, ['fetch', '--quiet', 'origin', t.branch], { okCodes: [0, 1, 128], timeout: 30_000 }).catch(() => null);
      const exists = await git.branchExists(repo, t.branch);
      let keep = exists;
      let note = '';
      if (exists) {
        const sha = await git.revParse(repo, t.branch);
        const remote = await git.remoteBranchSha(repo, t.branch);
        const merged = await git.isAncestor(repo, sha, t.baseBranch);
        const owned = await this.ownsBranch(repo, t);
        const ahead = await git.aheadCount(repo, t.baseBranch, t.branch).catch(() => 1);
        if ((remote === sha || merged) && owned) keep = false;
        if (keep) note = remote ? tr('Гілку {branch} залишено (на origin інша версія).', { branch: t.branch }) : tr('Гілку {branch} залишено (її немає на origin).', { branch: t.branch });
        else if (ahead === 0) note = tr('Нових комітів у {branch} не було — гілку прибрано.', { branch: t.branch });
        else note = remote === sha ? tr('Гілка {branch} уже на origin — локальну копію прибрано.', { branch: t.branch }) : tr('Гілка {branch} уже у {base} — локальну копію прибрано.', { branch: t.branch, base: t.baseBranch });
      }

      await this.stopAgent(taskId, { keepStatus: true });
      await this.d.watcher.unwatch(taskId);
      this.d.chat.drop(taskId);
      this.fileCache.delete(taskId);
      if (hasWt) await git.removeWorktree(repo, t.worktreePath);
      if (exists && !keep) await git.deleteBranch(repo, t.branch, true).catch((e) => this.log(`[task ${taskId}] branch delete: ${e.message}`));
      setTimeout(() => void this.dequeue(), 0);

      const task = this.update(taskId, { status: 'done', statusReason: note || null, mergedAt: now() });
      this.log(`[task ${taskId}] finished by hand. ${note}`);
      return { task, note, message: tr('Задачу завершено. {note}', { note }).trim() };
    });
  }

  async discard(taskId: number): Promise<Task> {
    const t = this.row(taskId);
    if (CLOSED_STATUSES.includes(t.status)) throw new UserError(tr('Задача вже закрита'), 409);
    const project = this.getProject(t.projectId);
    await this.withLock(project.repoPath, () => this.cleanup(taskId, { forceBranchDelete: true }));
    return this.update(taskId, { status: 'discarded', statusReason: null });
  }

  /** Kill the agent, drop the worktree and the branch. */
  private async cleanup(taskId: number, opts: { forceBranchDelete: boolean }) {
    const t = await this.syncBranch(taskId);
    const project = this.getProject(t.projectId);
    await this.stopAgent(taskId, { keepStatus: true });
    await this.d.watcher.unwatch(taskId);
    this.d.chat.drop(taskId);
    this.fileCache.delete(taskId);
    await git.removeWorktree(project.repoPath, t.worktreePath);
    if (await this.ownsBranch(project.repoPath, t)) {
      try {
        await git.deleteBranch(project.repoPath, t.branch, opts.forceBranchDelete);
      } catch (err) {
        this.log(`[task ${taskId}] branch delete: ${(err as Error).message}`);
        await git.deleteBranch(project.repoPath, t.branch, true).catch(() => {});
      }
    } else {
      this.log(`[task ${taskId}] keeping branch ${t.branch}: it existed before the task`);
    }
    // statuses are updated by the caller; free the slot for queued tasks
    setTimeout(() => void this.dequeue(), 0);
  }

  private ghChecked: boolean | null = null;

  private async hasGh(): Promise<boolean> {
    if (this.ghChecked) return true;
    try {
      await this.gh(['--version'], process.cwd());
      this.ghChecked = true;
    } catch {
      this.ghChecked = null; // check again next time (user may install it)
      return false;
    }
    return true;
  }

  private gh(args: string[], cwd: string): Promise<string> {
    return new Promise((res, rej) => {
      execFile(
        envVar('GH') || 'gh',
        args,
        { cwd, timeout: 60_000, env: { ...process.env, PATH: this.d.pathEnv ?? process.env.PATH, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          if (!err) return res(String(stdout).trim());
          const msg = String(stderr).trim() || err.message;
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return rej(new UserError(tr('gh (GitHub CLI) не встановлено: brew install gh && gh auth login')));
          rej(new UserError(`gh ${args[0]} ${args[1] ?? ''}: ${msg}`));
        },
      );
    });
  }

  /**
   * Commits leftovers, pushes the agent branch and opens a PR into the base branch.
   * If the PR already exists the push simply updates it.
   */
  async pr(taskId: number): Promise<{ url: string | null; created: boolean; manual?: boolean; output: string; task: Task }> {
    const t = await this.syncBranch(taskId);
    const project = this.getProject(t.projectId);
    if (t.status === 'running') throw new UserError(tr('Агент зараз працює — дочекайся паузи'), 409);
    if (!existsSync(t.worktreePath)) throw new UserError(tr('Worktree не існує'), 410);
    if (!(await git.currentBranch(t.worktreePath))) {
      throw new UserError(tr('У worktree агента відʼєднаний HEAD (detached) — попроси агента перейти на свою гілку.'), 409);
    }
    if (!(await git.hasRemote(project.repoPath))) throw new UserError(tr('У репозиторію немає remote (origin) — PR створити нікуди'), 409);
    await git.commitAll(t.worktreePath, `${t.title}\n\nCommitted by Vatra before opening a PR.`);
    const ahead = await git.aheadCount(project.repoPath, t.baseBranch, t.branch);
    if (ahead === 0) throw new UserError(tr('У гілці {branch} немає нових комітів відносно {base}', { branch: t.branch, base: t.baseBranch }), 409);
    // agents rebase on request, so a plain push may be rejected; lease keeps it safe
    const pushOut = await git.push(t.worktreePath, t.branch);

    let url = t.prUrl;
    let created = false;
    let out = '';
    if ((!url || t.prState === 'CLOSED') && !(await this.hasGh())) {
      // no GitHub CLI: the branch is pushed, open GitHub's "create PR" page instead
      const compare = git.githubCompareUrl(await git.remoteUrl(project.repoPath), t.baseBranch, t.branch);
      this.log(`[task ${taskId}] gh not installed; pushed ${t.branch}, compare page ${compare ?? '-'}`);
      return { url: compare, created: false, manual: true, output: pushOut, task: this.getTask(taskId) };
    }
    if (!url || t.prState === 'CLOSED') {
      const body = `${t.prompt ? `**${tr('Задача для агента:')}**\n\n> ${t.prompt.replace(/\n/g, '\n> ')}\n\n` : ''}${tr('Створено у Ватрі (Claude Code).')}`;
      try {
        out = await this.gh(['pr', 'create', '--head', t.branch, '--base', t.baseBranch, '--title', t.title, '--body', body], t.worktreePath);
        url = out.match(/https?:\/\/\S+/)?.[0] ?? null;
        created = true;
      } catch (err) {
        if (!/already exists/i.test((err as Error).message)) throw err;
        out = await this.gh(['pr', 'view', t.branch, '--json', 'url', '--jq', '.url'], t.worktreePath);
        url = out.match(/https?:\/\/\S+/)?.[0] ?? null;
      }
    }
    const task = this.update(taskId, { prUrl: url, prState: 'OPEN', statusReason: null });
    this.log(`[task ${taskId}] ${created ? 'opened' : 'updated'} PR ${url ?? ''}`);
    return { url, created, output: `${pushOut}\n${out}`.trim(), task };
  }

  /** Asks GitHub about the PR; a merged PR closes the task and cleans up locally. */
  async checkPr(taskId: number): Promise<Task> {
    const t = this.row(taskId);
    if (!t.prUrl) throw new UserError(tr('PR для задачі ще не створено'), 409);
    const cwd = existsSync(t.worktreePath) ? t.worktreePath : this.getProject(t.projectId).repoPath;
    const state = (await this.gh(['pr', 'view', t.prUrl, '--json', 'state', '--jq', '.state'], cwd)).trim().toUpperCase();
    if (state === t.prState && state !== 'MERGED') return this.dto(t);
    if (state === 'MERGED' && OPEN_STATUSES.includes(t.status)) {
      const project = this.getProject(t.projectId);
      await this.withLock(project.repoPath, () => this.cleanup(taskId, { forceBranchDelete: true }));
      await git.fetchQuiet(project.repoPath);
      const task = this.update(taskId, { status: 'merged', prState: 'MERGED', mergedAt: now(), statusReason: null });
      this.alert(taskId, tr('PR злито: {title}', { title: t.title }), tr('Агента зупинено, локальну гілку й worktree прибрано'));
      return task;
    }
    return this.update(taskId, { prState: state, statusReason: state === 'CLOSED' ? tr('PR закрито без злиття') : t.statusReason });
  }

  private pollingPrs = false;

  /** Background check of open PRs (every couple of minutes). */
  async pollPrs(): Promise<void> {
    if (this.pollingPrs) return;
    this.pollingPrs = true;
    try {
      const open = this.d.db
        .select()
        .from(tasks)
        .where(inArray(tasks.status, [...OPEN_STATUSES]))
        .all()
        .filter((t) => t.prUrl && t.prState === 'OPEN');
      if (!open.length || !(await this.hasGh())) return;
      for (const t of open) await this.checkPr(t.id).catch((e) => this.log(`[task ${t.id}] PR check: ${(e as Error).message}`));
    } finally {
      this.pollingPrs = false;
    }
  }

  /**
   * Agents sometimes rename or switch their branch (e.g. a CLAUDE.md that asks for
   * feat/… names). Follow whatever the worktree actually has checked out.
   */
  private async syncBranch(taskId: number): Promise<TaskRow> {
    const t = this.row(taskId);
    if (!existsSync(t.worktreePath)) return t;
    const cur = await git.currentBranch(t.worktreePath).catch(() => null);
    if (cur && cur !== t.branch) {
      this.log(`[task ${taskId}] agent moved to branch ${cur} (was ${t.branch})`);
      this.update(taskId, { branch: cur });
      return this.row(taskId);
    }
    return t;
  }

  /** Only delete branches the task created: agent/* or created after the task started. */
  private async ownsBranch(repo: string, t: TaskRow): Promise<boolean> {
    if (t.branch === `agent/${t.slug}`) return true;
    if (t.branch === t.baseBranch) return false;
    const created = await git.branchCreatedAt(repo, t.branch).catch(() => null);
    return created !== null && created >= Math.floor(Date.parse(t.createdAt) / 1000);
  }

  async open(taskId: number, app: OpenTarget): Promise<void> {
    const t = this.row(taskId);
    if (!existsSync(t.worktreePath)) throw new UserError(tr('Worktree не існує'), 410);
    await openIn(app, t.worktreePath);
  }

  // ------------------------------------------------------------- startup

  /** Reconciles DB state with git worktrees and tmux sessions after a (re)start. */
  async reconcile(): Promise<void> {
    for (const p of this.listProjects()) {
      if (!existsSync(p.repoPath)) {
        this.log(`[reconcile] project ${p.name}: repo missing at ${p.repoPath}`);
        continue;
      }
      await git.prune(p.repoPath).catch(() => {});
    }

    const open = this.d.db.select().from(tasks).where(inArray(tasks.status, [...OPEN_STATUSES])).all();
    const openIds = new Set(open.map((t) => t.id));

    for (const t of open) {
      const name = Tmux.sessionName(t.id);
      // sessions started before the rename were called ld-<id>
      if (await this.d.tmux.renameSession(`ld-${t.id}`, name)) this.log(`[reconcile] task ${t.id}: renamed tmux session ld-${t.id} → ${name}`);
      const pane = await this.d.tmux.pane(name);
      const wtExists = existsSync(t.worktreePath);

      if (t.status === 'creating') {
        this.setStatus(t.id, 'error', tr('Сервер перезапустився під час створення задачі — відкинь її і створи знову'));
        continue;
      }
      if (!wtExists) {
        if (pane.exists) await this.d.tmux.kill(name);
        this.setStatus(t.id, 'error', tr('Worktree зник з диска: {path}', { path: t.worktreePath }));
        continue;
      }
      if (pane.exists && !pane.dead) {
        this.d.hub.ensure(t.id, name);
        if (!LIVE.includes(t.status)) this.setStatus(t.id, 'running');
        // re-register hooks in case the server port changed
        writeHooks(t.worktreePath, this.d.config.port, t.id, t.hookToken, this.d.paths.runDir);
        const died = `${curlPost(hookUrl(this.d.config.port, t.id, t.hookToken, 'PaneDied'), '{}')} >/dev/null 2>&1 || true`;
        await this.d.tmux.onPaneDied(name, died).catch(() => {});
        this.log(`[reconcile] task ${t.id}: re-attached to ${name}`);
      } else if (LIVE.includes(t.status) || pane.exists) {
        await this.finalizeSession(t.id, pane.exitCode);
      }
      await this.watch(t.id);
      await this.syncBranch(t.id).catch(() => {});
      this.chatState(t.id); // start following the transcript, if known
    }

    // tmux sessions whose task is gone or closed
    for (const s of await this.d.tmux.listSessions()) {
      const m = s.match(/^(?:vatra|ld)-(\d+)$/);
      if (m && !openIds.has(Number(m[1]))) {
        this.log(`[reconcile] killing orphan tmux session ${s}`);
        await this.d.tmux.kill(s);
      }
    }
    await this.dequeue();
  }

  /**
   * Safety net for missed pane-died hooks: finalizes live tasks whose agent
   * process has exited or whose tmux session vanished.
   */
  async sweep(): Promise<void> {
    const live = this.d.db.select().from(tasks).where(inArray(tasks.status, LIVE)).all();
    if (!live.length) return;
    const panes = await this.d.tmux.allPanes();
    for (const t of live) {
      if (this.launching.has(t.id)) continue;
      const p = panes.get(Tmux.sessionName(t.id));
      if (p && !p.dead) {
        await this.inferWithoutHooks(t.id).catch((e) => this.log(`[task ${t.id}] transcript fallback: ${(e as Error).message}`));
        continue;
      }
      // re-check this task individually to avoid racing a launch in progress
      const now = await this.d.tmux.pane(Tmux.sessionName(t.id));
      if (now.exists && !now.dead) continue;
      const fresh = this.row(t.id);
      if (!LIVE.includes(fresh.status) || this.launching.has(t.id)) continue;
      this.log(`[sweep] task ${t.id}: agent exited (${now.exists ? `code ${now.exitCode}` : 'session gone'})`);
      await this.finalizeSession(t.id, now.exitCode);
    }
  }

  /**
   * Puts agents that have been waiting for you longer than `idleSleepMinutes` to sleep:
   * the claude process is closed (memory freed), the task stays open, and the next chat
   * message brings it back with --resume.
   */
  async sleepIdle(): Promise<void> {
    const minutes = this.d.config.idleSleepMinutes;
    if (!minutes || minutes <= 0) return;
    const idle = this.d.db.select().from(tasks).where(eq(tasks.status, 'idle')).all();
    for (const t of idle) {
      const since = this.idleSince.get(t.id);
      if (since === undefined) {
        this.idleSince.set(t.id, Date.now()); // e.g. right after a server restart
        continue;
      }
      if (Date.now() - since < minutes * 60_000) continue;
      if (this.launching.has(t.id) || this.d.chat.hasPermission(t.id) || this.hasOpenQuestion(t.id)) continue;
      this.log(`[task ${t.id}] idle for ${minutes} min — putting the agent to sleep`);
      await this.stopAgent(t.id, { keepStatus: true });
      const fresh = this.row(t.id);
      if (fresh.status === 'idle') {
        this.setStatus(t.id, 'sleeping', tr('Агент заснув після {minutes} хв простою — напиши в чат, щоб розбудити', { minutes }));
      }
      await this.dequeue();
    }
  }

  /** How far the base branch moved ahead of each open task's branch. */
  async refreshBaseAhead(opts: { fetch?: boolean; taskId?: number } = {}): Promise<void> {
    const open = this.d.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, [...OPEN_STATUSES]))
      .all()
      .filter((t) => (opts.taskId ? t.id === opts.taskId : true) && t.baseCommit && existsSync(t.worktreePath));
    const fetched = new Set<number>();
    for (const t of open) {
      const project = this.getProject(t.projectId);
      const repo = project.repoPath;
      const remote = await git.hasRemote(repo).catch(() => false);
      if (opts.fetch && remote && !fetched.has(project.id)) {
        fetched.add(project.id);
        await git.run(repo, ['fetch', '--quiet', 'origin'], { okCodes: [0, 1, 128], timeout: 60_000 }).catch(() => null);
      }
      const remoteRef = `origin/${t.baseBranch}`;
      const ref = remote && (await git.refExists(repo, `refs/remotes/${remoteRef}`)) ? remoteRef : t.baseBranch;
      const r = await git.run(repo, ['rev-list', '--count', `${t.branch}..${ref}`], { okCodes: [0, 128] }).catch(() => null);
      if (!r || r.code !== 0) continue;
      const count = Number(r.stdout.trim()) || 0;
      const prev = this.baseAhead.get(t.id);
      if (prev?.count === count && prev.ref === ref) continue;
      this.baseAhead.set(t.id, { count, ref });
      this.d.emit({ type: 'task', task: this.dto(this.row(t.id)) });
    }
  }

  /** Asks the agent to rebase onto the moved base branch (it resolves conflicts itself). */
  async rebase(taskId: number): Promise<{ delivered: 'typed' | 'relaunch'; ref: string }> {
    await this.refreshBaseAhead({ fetch: true, taskId });
    const t = this.row(taskId);
    const info = this.baseAhead.get(taskId);
    const ref = info?.ref ?? t.baseBranch;
    const fetchCmd = ref.startsWith('origin/') ? 'git fetch origin && ' : '';
    const moved = info?.count
      ? tr('Базова гілка {ref} пішла вперед на {count} коміт(ів).', { ref, count: info.count })
      : tr('Базова гілка {ref} пішла вперед.', { ref });
    const text =
      moved +
      ' ' +
      tr('Зроби rebase своєї гілки на неї ({cmd}), розвʼяжи конфлікти, якщо будуть, перевір, що все збирається і тести проходять, і коротко напиши, що змінилось.', {
        cmd: `${fetchCmd}git rebase ${ref}`,
      });
    const r = await this.sendMessage(taskId, text);
    return { ...r, ref };
  }

  /** Called by the watcher. */
  diffChanged(taskId: number) {
    this.d.emit({ type: 'diff_changed', taskId });
  }
}

// ----------------------------------------------------------------- helpers

function stripTerm(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Task title from the first meaningful line of the prompt. */
export function titleFromPrompt(prompt: string): string {
  const line =
    prompt
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim())
      .find(Boolean) ?? '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return (cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60) + '…').trim();
}

/** One line, so short messages with files can still be typed instead of pasted. */
export function withAttachments(text: string, files: string[]): string {
  return `${text}${text ? ' ' : ''}[${tr('прикріплені файли — прочитай через Read: {files}', { files: files.join(', ') })}]`;
}

/** Subsequence match ranked by basename hits and path length. */
export function fuzzyFilter(list: string[], q: string, limit: number): string[] {
  const query = q.trim().toLowerCase();
  if (!query) return list.filter((f) => !f.endsWith('/') || f.split('/').length === 2).slice(0, limit);
  const scored: [number, string][] = [];
  for (const f of list) {
    const lower = f.toLowerCase();
    const base = lower.replace(/\/$/, '').split('/').pop() ?? lower;
    let score: number;
    if (base.startsWith(query)) score = 0;
    else if (base.includes(query)) score = 1;
    else if (lower.includes(query)) score = 2;
    else {
      let i = 0;
      for (const ch of lower) if (ch === query[i]) i++;
      if (i < query.length) continue;
      score = 3;
    }
    scored.push([score * 1000 + f.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

function cleanEnvFiles(list?: string[]): string[] {
  // relative paths inside the repo only
  return (list ?? [])
    .map((s) => s.trim().replace(/^\.\//, ''))
    .filter((s) => s && !isAbsolute(s) && !s.split(/[\\/]/).includes('..'));
}

function safeDirName(name: string, id: number): string {
  return `${slugify(name, 30)}-${id}`;
}

export function buildLauncher(o: {
  cwd: string;
  claudeBin: string;
  args: string[];
  env: Record<string, string | undefined>;
  setupScript: string | null;
  probe?: string;
}): string {
  const lines = ['#!/bin/sh', '# Generated by Vatra for one agent session.', `cd ${shQuote(o.cwd)} || exit 1`];
  // Never let the CLI fall back to API billing: use the Max subscription login.
  lines.push('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN');
  // Inherited when Vatra itself was started from inside a Claude Code session: IS_DEMO in the
  // process environment makes claude skip all hooks, CLAUDECODE makes it think it's nested.
  // (IS_DEMO set in ~/.claude/settings.json "env" still applies — that one doesn't block hooks.)
  lines.push('unset IS_DEMO CLAUDECODE CLAUDE_CODE_ENTRYPOINT');
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined) lines.push(`export ${k}=${shQuote(v)}`);
  if (o.setupScript) {
    lines.push(
      `printf '\\033[36m[vatra] setup: %s\\033[0m\\n' ${shQuote(o.setupScript)}`,
      `/bin/sh -c ${shQuote(o.setupScript)}`,
      'rc=$?',
      `if [ "$rc" -ne 0 ]; then printf ${shQuote(`\\033[31m[vatra] ${tr('setup завершився з кодом %s — агент все одно стартує')}\\033[0m\\n`)} "$rc"; sleep 2; fi`,
    );
  }
  if (o.probe) lines.push(o.probe);
  lines.push(`exec ${[o.claudeBin, ...o.args].map(shQuote).join(' ')}`);
  return lines.join('\n') + '\n';
}
