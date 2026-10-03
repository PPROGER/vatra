import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Project, Session, Task, TaskStatus } from './shared/types.js';

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull().unique(),
  defaultBranch: text('default_branch').notNull(),
  setupScript: text('setup_script'),
  envFiles: text('env_files').notNull().default('[]'),
  mergeMode: text('merge_mode').notNull().default('pr').$type<'pr' | 'merge'>(),
  createdAt: text('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  prompt: text('prompt'),
  branch: text('branch').notNull(),
  baseBranch: text('base_branch').notNull(),
  baseCommit: text('base_commit'),
  worktreePath: text('worktree_path').notNull(),
  status: text('status').notNull().$type<TaskStatus>(),
  statusReason: text('status_reason'),
  port: integer('port'),
  hookToken: text('hook_token').notNull(),
  lastMessage: text('last_message'),
  createdAt: text('created_at').notNull(),
  mergedAt: text('merged_at'),
  prUrl: text('pr_url'),
  prState: text('pr_state'),
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => tasks.id),
  claudeSessionId: text('claude_session_id'),
  pid: integer('pid'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  exitCode: integer('exit_code'),
  logPath: text('log_path'),
  transcriptPath: text('transcript_path'),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  setup_script TEXT,
  env_files TEXT NOT NULL DEFAULT '[]',
  merge_mode TEXT NOT NULL DEFAULT 'pr',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  prompt TEXT,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  port INTEGER,
  hook_token TEXT NOT NULL,
  last_message TEXT,
  created_at TEXT NOT NULL,
  merged_at TEXT,
  pr_url TEXT,
  pr_state TEXT
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  claude_session_id TEXT,
  pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  log_path TEXT,
  transcript_path TEXT
);
CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task_id);
`;

/** Additive migrations for databases created by older versions. */
function migrate(sqlite: Database.Database) {
  const cols = (table: string) => new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  if (!cols('sessions').has('transcript_path')) sqlite.exec('ALTER TABLE sessions ADD COLUMN transcript_path TEXT');
  if (!cols('projects').has('merge_mode')) sqlite.exec("ALTER TABLE projects ADD COLUMN merge_mode TEXT NOT NULL DEFAULT 'pr'");
  const taskCols = cols('tasks');
  if (!taskCols.has('pr_url')) sqlite.exec('ALTER TABLE tasks ADD COLUMN pr_url TEXT');
  if (!taskCols.has('pr_state')) sqlite.exec('ALTER TABLE tasks ADD COLUMN pr_state TEXT');
}

export type DB = BetterSQLite3Database<{ projects: typeof projects; tasks: typeof tasks; sessions: typeof sessions }>;

export function openDb(file: string): { db: DB; sqlite: Database.Database } {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA);
  migrate(sqlite);
  const db = drizzle(sqlite, { schema: { projects, tasks, sessions } });
  return { db, sqlite };
}

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export function toProject(r: ProjectRow): Project {
  let envFiles: string[] = [];
  try {
    envFiles = JSON.parse(r.envFiles);
  } catch {
    /* keep empty */
  }
  return { ...r, envFiles };
}

export function toTask(r: TaskRow, extra: { alive?: boolean } = {}): Task {
  const { hookToken: _omit, ...rest } = r;
  return { ...rest, ...extra };
}

export function toSession(r: SessionRow): Session {
  return r;
}

export const now = () => new Date().toISOString();
