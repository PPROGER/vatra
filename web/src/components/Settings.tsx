import { useEffect, useState } from 'react';
import type { MachineInfo, ServerInfo } from '../../../server/shared/types';
import { api, machine as currentMachine, setMachine } from '../api';
import { t } from '../i18n';
import { Button, Field, inputCls, Modal } from './ui';

export function SettingsModal({ info, onClose, onSaved, onError }: { info: ServerInfo; onClose: () => void; onSaved: (i: ServerInfo) => void; onError: (m: string) => void }) {
  const [language, setLanguage] = useState(info.languageSetting);
  const [sleep, setSleep] = useState(String(info.idleSleepMinutes));
  const [maxActive, setMaxActive] = useState(String(info.maxActive));
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const next = await api.settings({ language, idleSleepMinutes: Math.max(0, Number(sleep) || 0), maxActive: Math.max(1, Math.round(Number(maxActive) || 1)) });
      onSaved(next);
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Налаштування')} onClose={onClose} width="max-w-md">
      <form onSubmit={save}>
        <Field label={t('Мова інтерфейсу')}>
          <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
            <option value="auto">{t('Авто (як у системі)')}</option>
            <option value="uk">Українська</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('Авто-сон агентів, хв')} hint={t('Агент, що чекає на тебе довше, закривається й звільняє памʼять; повідомлення в чат його розбудить. 0 — ніколи.')}>
          <input className={inputCls} type="number" min={0} max={1440} value={sleep} onChange={(e) => setSleep(e.target.value)} />
        </Field>
        <Field label={t('Максимум активних агентів')} hint={t('Решта задач чекає в черзі. Усі агенти ділять ліміти твоєї підписки.')}>
          <input className={inputCls} type="number" min={1} max={32} value={maxActive} onChange={(e) => setMaxActive(e.target.value)} />
        </Field>
        <div className="text-[11px] text-faint mb-3 font-mono break-all">
          {info.dataDir} · v{info.version}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Скасувати')}
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t('Зберегти')}
          </Button>
        </div>
      </form>
      <MachinesSection onError={onError} />
    </Modal>
  );
}

/** Remote machines: their own Vatra, reached through an ssh tunnel from this one. */
function MachinesSection({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<MachineInfo[]>([]);
  const [ssh, setSsh] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => api.machines().then(setList).catch(() => {});
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, []);
  const add = async () => {
    setBusy(true);
    try {
      await api.addMachine({ ssh: ssh.trim(), name: name.trim() || undefined });
      setSsh('');
      setName('');
      setList(await api.machines());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="text-[13px] font-medium mb-1">{t('Віддалені машини')}</div>
      <p className="text-[11.5px] text-muted leading-snug mb-2.5">
        {t('Агенти можуть працювати на сервері, а Ватра — на ноуті. На сервері встанови Ватру й запусти її у фоні:')}{' '}
        <code className="font-mono text-fg break-all">curl -fsSL https://raw.githubusercontent.com/PPROGER/vatra/main/install.sh | bash -s -- --service</code>
        {t(', а там один раз зроби claude → /login. Підключення — через SSH-ключ (без пароля), назовні нічого не відкривається.')}
      </p>
      {list.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[12.5px]">
          <span className={m.state === 'online' ? 'size-2 rounded-full bg-emerald-500' : m.state === 'connecting' ? 'size-2 rounded-full bg-amber-400 pulse-dot' : 'size-2 rounded-full bg-red-500'} />
          <span className="font-medium">{m.name}</span>
          <span className="font-mono text-faint truncate">{m.ssh}</span>
          {m.version && <span className="text-faint">v{m.version}</span>}
          <span className="ml-auto flex gap-1">
            {m.state === 'online' && currentMachine !== m.id && (
              <Button type="button" variant="ghost" onClick={() => setMachine(m.id)}>
                {t('Відкрити')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                if (!confirm(t('Прибрати машину {name}? Агенти на ній працюватимуть далі.', { name: m.name }))) return;
                await api.removeMachine(m.id).catch((e) => onError(e.message));
                if (currentMachine === m.id) setMachine(null);
                else setList(await api.machines());
              }}
            >
              ✕
            </Button>
          </span>
          {m.error && m.state !== 'online' && <div className="basis-full text-[11px] text-red-300/90 pl-4">{m.error}</div>}
        </div>
      ))}
      <div className="flex gap-1.5 mt-2">
        <input className={inputCls} placeholder={t('user@host або назва з ~/.ssh/config')} value={ssh} onChange={(e) => setSsh(e.target.value)} />
        <input className={inputCls + ' max-w-32'} placeholder={t('назва')} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="button" variant="default" busy={busy} disabled={!ssh.trim()} onClick={() => void add()}>
          {t('Додати')}
        </Button>
      </div>
    </div>
  );
}
