import { useState } from 'react';
import type { ServerInfo } from '../../../server/shared/types';
import { api } from '../api';
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
    </Modal>
  );
}
