// "New task" is just an empty chat: type what needs doing and send — the first
// message becomes the prompt, its first line becomes the title.
import { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../../server/shared/types';
import { api } from '../api';
import { Composer } from './Composer';
import { cx, inputCls } from './ui';

const EXAMPLES = [
  'Додай експорт замовлень у CSV з фільтром за датою',
  'Знайди, чому падають тести в api/orders, і виправ',
  '/init — створи CLAUDE.md для цього репозиторію',
  'Переглянь @src/ і запропонуй, що відрефакторити першим',
];

export function NewTask({
  projects,
  projectId,
  onProject,
  onCreated,
  toast,
}: {
  projects: Project[];
  projectId: number;
  onProject: (id: number) => void;
  onCreated: (taskId: number) => void;
  toast: (kind: 'error' | 'info' | 'success', title: string, body?: string) => void;
}) {
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState(project?.defaultBranch ?? '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = useMemo(() => ({ kind: 'project' as const, id: project?.id ?? 0 }), [project?.id]);

  useEffect(() => {
    if (!project) return;
    setBase(project.defaultBranch);
    api.branches(project.id).then(setBranches).catch(() => setBranches([]));
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return null;

  const create = async (text: string, attachments: { path: string }[]) => {
    setBusy(true);
    try {
      const t = await api.createTask(project.id, {
        title: title.trim() || undefined,
        prompt: text,
        base_branch: base,
        attachments: attachments.map((a) => a.path),
      });
      onCreated(t.id);
      return true;
    } catch (e) {
      toast('error', 'Не вдалося створити задачу', (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const branchOptions = [project.defaultBranch, ...branches.filter((b) => b !== project.defaultBranch && !b.startsWith('agent/'))];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 h-14 border-b border-line shrink-0">
        <h1 className="text-[15px] font-semibold">Нова задача</h1>
        <div className="flex items-center gap-2 ml-2 text-[12px]">
          <select className={cx(inputCls, 'h-7 py-0 w-auto')} value={project.id} onChange={(e) => onProject(Number(e.target.value))} title="Проєкт">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="text-faint">від</span>
          <select className={cx(inputCls, 'h-7 py-0 w-auto font-mono')} value={base} onChange={(e) => setBase(e.target.value)} title="Базова гілка">
            {branchOptions.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
        <input
          className={cx(inputCls, 'h-7 py-0 ml-auto max-w-80')}
          placeholder="Назва (необовʼязково — з першого рядка)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-5 pt-[12vh] pb-6">
          <div className="text-[20px] font-semibold mb-1.5">Що зробимо в {project.name}?</div>
          <p className="text-muted leading-relaxed mb-6">
            Напиши задачу як звичайне повідомлення. Ватра створить окрему гілку й worktree від <span className="font-mono text-fg">{base}</span>,
            запустить там claude і відкриє чат з ним. Можна прикріпити файли, згадати <span className="font-mono text-fg">@файл</span> чи почати з{' '}
            <span className="font-mono text-fg">/команди</span>.
          </p>
          <div className="grid gap-1.5">
            {EXAMPLES.map((ex) => (
              <div key={ex} className="text-[12.5px] text-faint border border-line rounded-lg px-3 py-2">
                {ex}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-5 pb-5">
        <Composer
          scope={scope}
          autoFocus
          disabled={busy}
          sendLabel={busy ? 'Створюю…' : 'Почати'}
          placeholder="Опиши задачу для агента…"
          onSend={(t, a) => create(t, a)}
          onError={(m) => toast('error', 'Помилка', m)}
        />
      </div>
    </div>
  );
}
