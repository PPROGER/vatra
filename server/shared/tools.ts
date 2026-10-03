// Shared by server and UI — no Node imports here.

/** Short human description of a tool call, for status lines and permission cards. */
export function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (name) {
    case 'Bash':
      return `Bash: ${s('command').split('\n')[0].slice(0, 160)}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name}: ${s('file_path') || s('notebook_path')}`;
    case 'Glob':
    case 'Grep':
      return `${name}: ${s('pattern')}`;
    case 'WebFetch':
      return `WebFetch: ${s('url')}`;
    case 'WebSearch':
      return `WebSearch: ${s('query')}`;
    case 'Task':
    case 'Agent':
      return `Субагент: ${s('description')}`;
    case 'TodoWrite':
      return 'Оновлює список задач';
    default:
      return name;
  }
}
