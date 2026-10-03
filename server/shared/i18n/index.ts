// Tiny i18n shared by the server and the UI. Source strings in the code are Ukrainian
// and double as keys; English lives in the en-*.ts dictionaries. Placeholders: {name}.
import { EN_CLI } from './en-cli.js';
import { EN_SERVER } from './en-server.js';
import { EN_WEB_APP } from './en-web-app.js';
import { EN_WEB_CHAT } from './en-web-chat.js';

export type Lang = 'uk' | 'en';

export const EN: Record<string, string> = { ...EN_SERVER, ...EN_CLI, ...EN_WEB_CHAT, ...EN_WEB_APP };

let current: Lang = 'uk';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

function fill(template: string, vars?: Record<string, string | number | null | undefined>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m));
}

/** Translate a Ukrainian source string into the current language. */
export function tr(uk: string, vars?: Record<string, string | number | null | undefined>, lang: Lang = current): string {
  return fill(lang === 'en' ? (EN[uk] ?? uk) : uk, vars);
}

/** Marks a string for translation without translating it yet (for constants used later via tr/t). */
export const tk = (uk: string): string => uk;
