// Types shared by the server and the web UI. Keep this file dependency-free.

export const TASK_STATUSES = [
  'creating',
  'queued',
  'running',
  'idle',
  'review',
  /** Agent was put to sleep after being idle too long; a chat message wakes it up with --resume. */
  'sleeping',
  'merged',
  'discarded',
  /** Finished by hand (e.g. you pushed from the chat): agent stopped, worktree removed, chat archived. */
  'done',
  'error',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses in which the task still owns a worktree and a branch. */
export const OPEN_STATUSES: readonly TaskStatus[] = ['creating', 'queued', 'running', 'idle', 'review', 'sleeping', 'error'];

/** Statuses in which the agent's work can be merged / PR'd / finished. */
export const SETTLED_STATUSES: readonly TaskStatus[] = ['idle', 'review', 'sleeping', 'error', 'queued'];

/** Closed tasks: kept for their chat history (the archive). */
export const CLOSED_STATUSES: readonly TaskStatus[] = ['merged', 'discarded', 'done'];

export interface Project {
  id: number;
  name: string;
  repoPath: string;
  defaultBranch: string;
  setupScript: string | null;
  envFiles: string[];
  /** How finished tasks land: a GitHub pull request, or a local git merge. */
  mergeMode: 'pr' | 'merge';
  createdAt: string;
}

export interface Task {
  id: number;
  projectId: number;
  title: string;
  slug: string;
  prompt: string | null;
  branch: string;
  baseBranch: string;
  baseCommit: string | null;
  worktreePath: string;
  status: TaskStatus;
  statusReason: string | null;
  port: number | null;
  createdAt: string;
  mergedAt: string | null;
  prUrl: string | null;
  /** OPEN | MERGED | CLOSED as reported by gh. */
  prState: string | null;
  /** True while a tmux session for this task exists. Computed, not stored. */
  alive?: boolean;
  /** Commits the base branch (origin/<base> when there is a remote) has that the agent branch lacks. */
  baseAhead?: number | null;
  /** The ref baseAhead was measured against, e.g. origin/staging. */
  baseRef?: string | null;
  /** Short line from the last Notification hook ("Claude needs your permission…"). */
  lastMessage?: string | null;
}

export interface Session {
  id: number;
  taskId: number;
  claudeSessionId: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  logPath: string | null;
  transcriptPath: string | null;
}

export type DiffMode = 'all' | 'committed' | 'working';

export interface DiffResult {
  mode: DiffMode;
  baseCommit: string;
  patch: string;
  /** Untracked files included in the patch (working/all modes). */
  untracked: string[];
  stats: { files: number; additions: number; deletions: number };
  truncated: boolean;
}

export type ServerEvent =
  | { type: 'task'; task: Task }
  | { type: 'task_removed'; taskId: number }
  | { type: 'project'; project: Project }
  | { type: 'project_removed'; projectId: number }
  | { type: 'diff_changed'; taskId: number }
  | { type: 'notify'; taskId: number; title: string; body: string }
  | { type: 'chat'; taskId: number; items: ChatItem[]; context: ChatContext | null }
  | { type: 'chat_reset'; taskId: number }
  | { type: 'chat_meta'; taskId: number; permission: ChatState['permission']; activity: string | null };

export interface ServerInfo {
  version: string;
  platform: string;
  dataDir: string;
  maxActive: number;
  idleSleepMinutes: number;
  /** Effective UI language. */
  language: 'uk' | 'en';
  /** The setting: auto / uk / en. */
  languageSetting: 'auto' | 'uk' | 'en';
  claudeBin: string | null;
  warnings: string[];
}

// ---------------------------------------------------------------- chat

export interface ChatAttachment {
  name: string;
  path: string;
  isImage: boolean;
}

export type ChatItem =
  | { kind: 'user'; id: string; ts: string; text: string; command?: string; bash?: boolean }
  | { kind: 'assistant'; id: string; ts: string; text: string }
  | { kind: 'thinking'; id: string; ts: string; text: string }
  | {
      kind: 'tool';
      id: string;
      ts: string;
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      done: boolean;
    }
  | { kind: 'system'; id: string; ts: string; text: string; tone?: 'info' | 'error' | 'output' };

export interface ChatContext {
  model: string | null;
  usedTokens: number;
  windowTokens: number;
}

export interface ChatState {
  sessionId: string | null;
  items: ChatItem[];
  context: ChatContext | null;
  /** Agent waits for a permission answer (from Notification hook). */
  permission: { message: string; tool: string | null; kind?: 'tool' | 'trust' } | null;
  /** What the agent is doing right now (from PreToolUse hook). */
  activity: string | null;
}

export interface SlashCommand {
  name: string;
  description: string;
  source: 'builtin' | 'project' | 'user' | 'skill';
  /** Opens an interactive picker/editor in the TUI — answer it in the terminal. */
  interactive?: boolean;
  args?: string;
}
