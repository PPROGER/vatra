// Branch-safe slugs from task titles, including Ukrainian/Russian titles.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ъ: '', ы: 'y', э: 'e', ё: 'e', "'": '', 'ʼ': '', '’': '',
};

export function slugify(title: string, maxLen = 40): string {
  const lower = title.toLowerCase();
  let s = '';
  for (const ch of lower) s += TRANSLIT[ch] ?? ch;
  s = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+[^-]*$/, '') || s.slice(0, maxLen);
  return s.replace(/-+$/g, '') || 'task';
}

/** Appends -2, -3… until `taken` returns false. */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean> | boolean): Promise<string> {
  if (!(await taken(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const s = `${base}-${i}`;
    if (!(await taken(s))) return s;
  }
  return `${base}-${Date.now()}`;
}
