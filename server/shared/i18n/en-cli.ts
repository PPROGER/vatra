// English translations: Ukrainian source text (the key) → English. Placeholders: {name}.
export const EN_CLI: Record<string, string> = {
  // cli.ts
  'Vatra підтримує лише macOS і Linux (Windows — через WSL2).': 'Vatra supports only macOS and Linux (Windows via WSL2).',
  'tmux не знайдено. Встанови: brew install tmux  /  sudo apt install tmux': 'tmux not found. Install it: brew install tmux  /  sudo apt install tmux',
  'claude CLI не знайдено — задачі не зможуть стартувати. Встанови Claude Code або вкажи claudeBin у config.json.':
    'claude CLI not found — tasks will not be able to start. Install Claude Code or set claudeBin in config.json.',
  'У середовищі сервера є ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN — для агентів їх буде прибрано, щоб працювала підписка.':
    'ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN is set in the server environment — it will be removed for agents so your subscription is used.',
  'Порт {port} уже зайнятий — мабуть, Ватра вже працює: http://localhost:{port}': 'Port {port} is already in use — Vatra is probably already running: http://localhost:{port}',
  'Інший порт: VATRA_PORT=4318 vatra start (або "port" у config.json).': 'Another port: VATRA_PORT=4318 vatra start (or "port" in config.json).',
  'Не вдалося зайняти 127.0.0.1:{port}: {error}': 'Could not bind 127.0.0.1:{port}: {error}',
  'Ватра (Vatra) {version} · {url}': 'Vatra {version} · {url}',
  'дані: {dir} · tmux: {tmux} (-L {socket}) · claude: {claude}': 'data: {dir} · tmux: {tmux} (-L {socket}) · claude: {claude}',
  '{signal}: зупиняюсь. Агенти лишаються жити в tmux і підхопляться при наступному старті.':
    '{signal}: stopping. Agents keep running in tmux and will be picked up on the next start.',
  'не знайдено в PATH': 'not found in PATH',
  'gh (для PR)': 'gh (for PRs)',
  'залогінено': 'logged in',
  'ANTHROPIC_API_KEY задано — сервер прибере його для агентів': 'ANTHROPIC_API_KEY is set — the server will remove it for agents',
  'дані: {dir}': 'data: {dir}',
  'Прибрано старий автозапуск {file}': 'Removed old autostart entry {file}',
  'Записано {file}': 'Wrote {file}',
  'Сервіс запущено. UI: http://localhost:4317': 'Service started. UI: http://localhost:4317',
  'Не вдалося запустити сервіс: {error}': 'Could not start the service: {error}',
  'Видалено {file}. Агенти в tmux (-L vatra) не зачеплено.': 'Removed {file}. Agents in tmux (-L vatra) were left untouched.',
  'Відкрий у браузері: {url}': 'Open in your browser: {url}',
  '{dir} — не git-клон, оновлюй тим самим способом, яким встановлював.': '{dir} is not a git clone — update it the same way you installed it.',
  'Сервіс перезапущено.': 'Service restarted.',
  'Перезапусти сервер вручну, щоб підхопити нову версію.': 'Restart the server manually to pick up the new version.',
  'Готово. Перезапусти `vatra start`, якщо сервер зараз працює.': 'Done. Restart `vatra start` if the server is currently running.',
  'Потрібен Node.js 22+, зараз {version}.': 'Node.js 22+ is required, found {version}.',
  [`Ватра (vatra) {version} — паралельні агенти Claude Code в git worktrees

Використання: vatra <команда>

  start [--open]       запустити сервер (UI на {url}); --open відкриє браузер
  open                 відкрити UI в браузері
  doctor               перевірити git, tmux, claude, gh і нативні модулі
  selftest [--keep]    прогнати справжнього claude через запущену Ватру (довіра, хуки, дозволи, чат)
  update               git pull + install + build (і перезапуск сервісу)
  install-service      автозапуск у фоні (launchd / systemd --user)
  uninstall-service    прибрати автозапуск
  url                  надрукувати адресу UI
  version              версія
`]: `Vatra {version} — parallel Claude Code agents in git worktrees

Usage: vatra <command>

  start [--open]       start the server (UI at {url}); --open opens the browser
  open                 open the UI in the browser
  doctor               check git, tmux, claude, gh and native modules
  selftest [--keep]    run a real claude through the running Vatra (trust, hooks, permissions, chat)
  update               git pull + install + build (and restart the service)
  install-service      run in the background at login (launchd / systemd --user)
  uninstall-service    remove the autostart
  url                  print the UI address
  version              print the version
`,

  // selftest.ts
  'Vatra selftest — справжній claude, кілька запитів до твоєї підписки.': 'Vatra selftest — a real claude, a few requests against your subscription.',
  'сервер {version} на {url}, claude: {claude}': 'server {version} at {url}, claude: {claude}',
  'claude не знайдено — встанови Claude Code і зроби /login': 'claude not found — install Claude Code and run /login',
  'сервер не відповідає ({error}). Запусти: vatra start': 'server is not responding ({error}). Start it: vatra start',
  'агент не стартував за 60 с': 'agent did not start within 60 s',
  'помилка старту: {reason}': 'start error: {reason}',
  'worktree створено, claude запущено в tmux': 'worktree created, claude started in tmux',
  'питання «довіряти папці?» розпізнано — картка в чаті зʼявилась': 'the "trust this folder?" prompt was recognized — the card appeared in the chat',
  'claude не питав про довіру до папки (мабуть, вона вже довірена) — картку не перевірено':
    'claude did not ask about folder trust (it is probably trusted already) — the card was not checked',
  'ні картки довіри, ні хуків за 45 с — глянь вкладку «Термінал», claude може чекати на щось':
    'no trust card and no hooks within 45 s — check the "Terminal" tab, claude may be waiting for something',
  'хуки Claude Code працюють, транскрипт знайдено': 'Claude Code hooks work, transcript found',
  'запит дозволу зʼявився в чаті: {what}': 'permission request appeared in the chat: {what}',
  'кнопка «Дозволити» спрацювала — команда виконалась': 'the "Allow" button worked — the command ran',
  'після «Дозволити» команда не виконалась — порядок пунктів у меню дозволу інший, скажи про це':
    'the command did not run after "Allow" — the permission menu order is different, please report this',
  'дозвіл не знадобився (Bash уже дозволено у твоїх налаштуваннях) — картку дозволу не перевірено':
    'no permission was needed (Bash is already allowed in your settings) — the permission card was not checked',
  'ні запиту дозволу, ні результату за 150 с': 'no permission request and no result within 150 s',
  'агент виконав команду в своєму worktree': 'the agent ran the command in its worktree',
  'хід завершився — статус «чекає»': 'turn finished — status "waiting"',
  'транскрипт claude не знайдено за 60 с — чат не працюватиме': "claude's transcript not found within 60 s — the chat won't work",
  'claude не запускає хуки Ватри — працюю з його транскриптом напряму (статус може оновлюватись із затримкою в кілька секунд)':
    "claude doesn't run Vatra's hooks — reading its transcript directly instead (status may lag by a few seconds)",
  'дозвіл не знадобився — у твоїх налаштуваннях claude режим дозволів «{mode}» — картку дозволу не перевірено':
    'no permission needed — your claude settings use permission mode "{mode}" — the permission card was not checked',
  'агент не перейшов у «чекає» за 120 с': 'the agent did not switch to "waiting" within 120 s',
  'відповідь агента видно в чаті': "the agent's reply is visible in the chat",
  'у чаті немає відповіді агента — парсер транскрипту не впізнав формат': "no agent reply in the chat — the transcript parser didn't recognize the format",
  'контекст: {model}, {tokens} токенів': 'context: {model}, {tokens} tokens',
  'немає даних про використання контексту': 'no context usage data',
  'багаторядкове повідомлення не дійшло': 'the multi-line message did not arrive',
  'багаторядкове повідомлення дійшло одним повідомленням': 'the multi-line message arrived as a single message',
  'багаторядкове повідомлення розбилось на кілька — скажи про це': 'the multi-line message was split into several — please report this',
  'slash-команда /cost виконалась і видна в чаті': 'the /cost slash command ran and is visible in the chat',
  '/cost не зʼявився в чаті (команда могла виконатись, але без запису в транскрипт)':
    "/cost did not appear in the chat (the command may have run but wasn't written to the transcript)",
  '(--keep) задачу й проєкт лишено: {repo}': '(--keep) task and project kept: {repo}',
  '{n} проблем(и)': '{n} problem(s)',
  'Усе працює': 'Everything works',
  ', {n} попередж.': ', {n} warning(s)',
  'Скопіюй цей вивід, якщо треба щось поправити.': 'Copy this output if something needs fixing.',
};
