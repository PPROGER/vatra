import { useEffect, useState } from 'react';
import type { Project } from '../../../server/shared/types';
import { api, type RepoInspect } from '../api';
import { FolderBrowser } from './FolderPicker';
import { Button, cx, Field, inputCls, Modal } from './ui';

function MergeModeField({ value, onChange }: { value: 'pr' | 'merge'; onChange: (v: 'pr' | 'merge') => void }) {
  const opts: { v: 'pr' | 'merge'; title: string; hint: string }[] = [
    { v: 'pr', title: 'Pull request', hint: 'головна кнопка «Створити PR»; задача закривається, коли PR зіллють. «Злити» теж доступне в меню' },
    { v: 'merge', title: 'Злиття', hint: 'головна кнопка «Злити»: merge у базову гілку, за бажанням одразу push' },
  ];
  return (
    <Field label="Як завершувати задачі">
      <div className="grid grid-cols-2 gap-2">
        {opts.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={cx(
              'text-left rounded-lg border px-3 py-2 cursor-pointer',
              value === o.v ? 'border-accent/70 bg-accent/10' : 'border-line-2 hover:border-[#3a4150]',
            )}
          >
            <div className="text-[12.5px] text-fg font-medium">{o.title}</div>
            <div className="text-[11px] text-faint leading-snug mt-0.5">{o.hint}</div>
          </button>
        ))}
      </div>
    </Field>
  );
}

const splitList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function NewProjectModal({ onClose, onDone, onError }: { onClose: () => void; onDone: (p: Project) => void; onError: (m: string) => void }) {
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [setup, setSetup] = useState('');
  const [envFiles, setEnvFiles] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [info, setInfo] = useState<RepoInspect | null>(null);
  const [repos, setRepos] = useState<{ name: string; path: string }[] | null>(null);
  const [touched, setTouched] = useState({ name: false, setup: false, env: false });
  const [mergeMode, setMergeMode] = useState<'pr' | 'merge'>('pr');

  useEffect(() => {
    api.fsRepos().then(setRepos).catch(() => setRepos([]));
  }, []);

  // inspect the chosen folder and prefill the form
  useEffect(() => {
    if (!repo.trim()) {
      setInfo(null);
      return;
    }
    const h = setTimeout(() => {
      api
        .fsInspect(repo.trim())
        .then((i) => {
          setInfo(i);
          if (!touched.name) setName(i.name);
          if (!touched.setup) setSetup(i.suggestedSetup ?? '');
          if (!touched.env) setEnvFiles(i.envFiles.join('\n'));
        })
        .catch(() => setInfo(null));
    }, 250);
    return () => clearTimeout(h);
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickNative = async () => {
    setPicking(true);
    try {
      const r = await api.fsPick(repo || undefined);
      if (r.path) setRepo(r.path);
    } catch (err) {
      onError((err as Error).message);
      setBrowse(true);
    } finally {
      setPicking(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api.addProject({ repo_path: info?.root ?? repo, name: name || undefined, setup_script: setup || undefined, env_files: splitList(envFiles), merge_mode: mergeMode });
      onDone(p);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (browse) return <FolderBrowser start={repo || undefined} onClose={() => setBrowse(false)} onPick={(p) => (setRepo(p), setBrowse(false))} />;

  return (
    <Modal title="Новий проєкт" onClose={onClose} width="max-w-xl">
      <form onSubmit={submit}>
        <Field
          label="Репозиторій"
          hint={
            info ? (
              info.isGit ? (
                <span className="text-emerald-400">
                  ◆ git · основна гілка {info.defaultBranch}
                  {info.root && info.root !== info.path ? ` · корінь: ${info.root}` : ''}
                </span>
              ) : (
                <span className="text-amber-300">Це не git-репозиторій</span>
              )
            ) : (
              'Обери папку через Finder або вбудований оглядач, чи встав шлях'
            )
          }
        >
          <div className="flex gap-1.5">
            <input className={inputCls + ' font-mono'} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="~/Documents/projects/my-app" autoFocus required />
            <Button type="button" onClick={pickNative} busy={picking} title="Системний діалог вибору папки">
              Finder…
            </Button>
            <Button type="button" onClick={() => setBrowse(true)} title="Вбудований оглядач папок">
              Огляд…
            </Button>
          </div>
        </Field>
        {repos && repos.length > 0 && !repo && (
          <div className="mb-4 -mt-1">
            <div className="text-[11px] text-faint mb-1.5">Знайдені репозиторії</div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {repos.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  title={r.path}
                  onClick={() => setRepo(r.path)}
                  className="h-6 px-2 rounded-md border border-line-2 text-[12px] text-muted hover:text-fg hover:border-accent/50 cursor-pointer"
                >
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Назва">
          <input className={inputCls} value={name} onChange={(e) => (setName(e.target.value), setTouched((t) => ({ ...t, name: true })))} />
        </Field>
        <Field label="Setup script" hint="Виконується у новому worktree перед стартом агента; вивід видно в терміналі">
          <input
            className={inputCls + ' font-mono'}
            value={setup}
            onChange={(e) => (setSetup(e.target.value), setTouched((t) => ({ ...t, setup: true })))}
            placeholder="pnpm install --prefer-offline"
          />
        </Field>
        <Field label="Файли для копіювання" hint="Невідстежувані файли з основного репо (.env тощо), по одному в рядку">
          <textarea
            className={inputCls + ' font-mono h-16 resize-none'}
            value={envFiles}
            onChange={(e) => (setEnvFiles(e.target.value), setTouched((t) => ({ ...t, env: true })))}
          />
        </Field>
        <MergeModeField value={mergeMode} onChange={setMergeMode} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Скасувати
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={info ? !info.isGit : false}>
            Додати проєкт
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectSettingsModal({
  project,
  onClose,
  onError,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onError: (m: string) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [setup, setSetup] = useState(project.setupScript ?? '');
  const [envFiles, setEnvFiles] = useState(project.envFiles.join('\n'));
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [mergeMode, setMergeMode] = useState<'pr' | 'merge'>(project.mergeMode ?? 'pr');
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.branches(project.id).then(setBranches).catch(() => {});
  }, [project.id]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateProject(project.id, { name, setup_script: setup || null, env_files: splitList(envFiles), default_branch: defaultBranch, merge_mode: mergeMode });
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Прибрати проєкт «${project.name}» зі списку Ватри? Сам репозиторій не зачіпається.`)) return;
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <Modal title={`Налаштування · ${project.name}`} onClose={onClose}>
      <form onSubmit={save}>
        <div className="mb-3.5 text-[12px] text-muted font-mono break-all">{project.repoPath}</div>
        <Field label="Назва">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Основна гілка">
          <select className={inputCls} value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)}>
            {[defaultBranch, ...branches.filter((b) => b !== defaultBranch && !b.startsWith('agent/'))].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Field>
        <Field label="Setup script">
          <input className={inputCls + ' font-mono'} value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="pnpm install --prefer-offline" />
        </Field>
        <Field label="Файли для копіювання">
          <textarea className={inputCls + ' font-mono h-16 resize-none'} value={envFiles} onChange={(e) => setEnvFiles(e.target.value)} />
        </Field>
        <MergeModeField value={mergeMode} onChange={setMergeMode} />
        <div className="flex items-center gap-2 pt-1">
          <Button type="button" variant="danger" onClick={remove}>
            Прибрати проєкт
          </Button>
          <div className="flex-1" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Скасувати
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Зберегти
          </Button>
        </div>
      </form>
    </Modal>
  );
}
