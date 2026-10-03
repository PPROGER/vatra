import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ServerEvent, ServerInfo, Task } from '../../server/shared/types';
import { api, subscribeEvents, token } from './api';
import { NewProjectModal, ProjectSettingsModal } from './components/Modals';
import { NewTask } from './components/NewTask';
import { SettingsModal } from './components/Settings';
import { Palette } from './components/Palette';
import { CLOSED_STATUSES } from '../../server/shared/types';
import { Sidebar } from './components/Sidebar';
import { TaskView } from './components/TaskView';
import { Button, Toasts, type Toast } from './components/ui';

function draftFromHash(): number | null {
  const m = location.hash.match(/^#\/new\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function selectedFromHash(): number | null {
  const m = location.hash.match(/^#\/task\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function App() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<number | null>(selectedFromHash);
  const [diffTicks, setDiffTicks] = useState<Record<number, number>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<
    { kind: 'project' } | { kind: 'settings'; project: Project } | { kind: 'app' } | null
  >(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast['kind'], title: string, body?: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, kind, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);

  const [draft, setDraft] = useState<number | null>(draftFromHash);

  const select = useCallback((id: number | null) => {
    setSelected(id);
    if (id) setDraft(null);
    history.replaceState(null, '', id ? `#/task/${id}` : location.pathname);
  }, []);

  /** Opens the "new task" chat for a project. */
  const newTask = useCallback((projectId: number) => {
    setSelected(null);
    setDraft(projectId);
    history.replaceState(null, '', `#/new/${projectId}`);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [i, p, t] = await Promise.all([api.info(), api.projects(), api.tasks()]);
      setInfo(i);
      setProjects(p);
      setTasks(t);
      setAuthError(null);
    } catch (e) {
      setAuthError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const onEvent = (e: ServerEvent) => {
      switch (e.type) {
        case 'task':
          setTasks((ts) => {
            const i = ts.findIndex((t) => t.id === e.task.id);
            if (i === -1) return [e.task, ...ts];
            const copy = ts.slice();
            copy[i] = e.task;
            return copy;
          });
          break;
        case 'task_removed':
          setTasks((ts) => ts.filter((t) => t.id !== e.taskId));
          break;
        case 'project':
          setProjects((ps) => {
            const i = ps.findIndex((p) => p.id === e.project.id);
            if (i === -1) return [...ps, e.project];
            const copy = ps.slice();
            copy[i] = e.project;
            return copy;
          });
          break;
        case 'project_removed':
          setProjects((ps) => ps.filter((p) => p.id !== e.projectId));
          setTasks((ts) => ts.filter((t) => t.projectId !== e.projectId));
          break;
        case 'diff_changed':
          setDiffTicks((d) => ({ ...d, [e.taskId]: (d[e.taskId] ?? 0) + 1 }));
          break;
        case 'notify':
          if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const n = new Notification(e.title, { body: e.body, tag: `ld-${e.taskId}` });
            n.onclick = () => {
              window.focus();
              select(e.taskId);
            };
          }
          break;
      }
    };
    // reload everything on (re)connect so nothing missed while offline
    return subscribeEvents(onEvent, (ok) => {
      setConnected(ok);
      if (ok) void loadAll();
    });
  }, [loadAll, select]);

  const [palette, setPalette] = useState(false);

  // ⌘K / Ctrl+K — palette; Alt+↑/↓ — previous/next open task (sidebar order)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const order = projects.flatMap((p) => tasks.filter((t) => t.projectId === p.id && !CLOSED_STATUSES.includes(t.status)));
        if (!order.length) return;
        e.preventDefault();
        const i = order.findIndex((t) => t.id === selected);
        const next = e.key === 'ArrowDown' ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
        select(order[i === -1 ? 0 : next].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projects, tasks, selected, select]);

  // title shows how many agents are waiting
  useEffect(() => {
    const waiting = tasks.filter((t) => t.status === 'idle').length;
    document.title = waiting ? `(${waiting}) Ватра` : 'Ватра';
  }, [tasks]);

  const task = tasks.find((t) => t.id === selected) ?? null;

  if (!token || authError === 'Bad token') {
    return (
      <div className="h-full grid place-items-center text-muted p-6 text-center">
        <div>
          <div className="text-fg font-semibold mb-2">Немає токена доступу</div>
          Відкрий UI за адресою, яку друкує сервер при старті (http://localhost:4317).
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        projects={projects}
        tasks={tasks}
        selected={selected}
        info={info}
        connected={connected}
        onSelect={select}
        onNewProject={() => setModal({ kind: 'project' })}
        onNewTask={(p) => newTask(p.id)}
        drafting={task ? null : (draft ?? projects[0]?.id ?? null)}
        onSettings={() => setModal({ kind: 'app' })}
        onPalette={() => setPalette(true)}
        onProjectSettings={(p) => setModal({ kind: 'settings', project: p })}
      />
      <main className="flex-1 min-w-0">
        {task ? (
          <TaskView key={task.id} task={task} project={projects.find((p) => p.id === task.projectId)} diffTick={diffTicks[task.id] ?? 0} toast={toast} />
        ) : projects.length > 0 ? (
          <NewTask
            projects={projects}
            projectId={draft && projects.some((p) => p.id === draft) ? draft : projects[0].id}
            onProject={newTask}
            onCreated={select}
            toast={toast}
          />
        ) : (
          <Empty onAdd={() => setModal({ kind: 'project' })} />
        )}
      </main>

      {modal?.kind === 'project' && (
        <NewProjectModal
          onClose={() => setModal(null)}
          onError={(m) => toast('error', 'Не вдалося додати проєкт', m)}
          onDone={(p) => {
            setModal(null);
            newTask(p.id);
          }}
        />
      )}
      {modal?.kind === 'settings' && (
        <ProjectSettingsModal
          project={modal.project}
          onClose={() => setModal(null)}
          onError={(m) => toast('error', 'Помилка', m)}
          onDeleted={() => setModal(null)}
        />
      )}
      {palette && <Palette projects={projects} tasks={tasks} onClose={() => setPalette(false)} onTask={select} onNew={newTask} />}
      {modal?.kind === 'app' && info && (
        <SettingsModal info={info} onClose={() => setModal(null)} onSaved={setInfo} onError={(m) => toast('error', 'Помилка', m)} />
      )}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="h-full grid place-items-center p-8">
      <div className="max-w-md">
        <h1 className="text-[18px] font-semibold mb-2">Розпалимо Ватру</h1>
        <p className="text-muted leading-relaxed mb-5">
          Кожна задача — окрема гілка <code className="font-mono text-fg">agent/&lt;slug&gt;</code> у своєму git worktree з власним інтерактивним{' '}
          <code className="font-mono text-fg">claude</code>. Агенти працюють паралельно на твоїй підписці, ти спілкуєшся з ними в чаті, дивишся диф і зливаєш, коли готово.
        </p>
        <ol className="text-muted space-y-1.5 mb-6 list-decimal list-inside">
          <li>Додай проєкт — обери папку з git-репозиторієм.</li>
          <li>Напиши задачу в чаті — агент стартує сам.</li>
          <li>Коли агент чекає, прийде сповіщення. Переглянь диф → «Злити».</li>
        </ol>
        <Button variant="primary" onClick={onAdd}>
          Додати проєкт
        </Button>
      </div>
    </div>
  );
}
