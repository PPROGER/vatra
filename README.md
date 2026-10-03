# 🔥 Vatra

**English** · [Українська](README.uk.md)

Vatra (Ukrainian for *campfire*) is a local web dashboard for running several **interactive Claude Code agents in parallel**. Every task gets its own git worktree and branch, its own `claude` running in a real terminal (tmux), and a chat window where you talk to it. When the work is done you review the diff and open a PR or merge it.

- Runs entirely on your machine (macOS, Linux, WSL2). Nothing is uploaded anywhere.
- Uses the official `claude` CLI in interactive mode, so it runs on your Claude Pro/Max subscription. It doesn't use `claude -p` or the Agent SDK.
- Isolation is file-level only (worktree + branch); agents run as your user.

> The UI is currently in Ukrainian.

## Install

One command (macOS, Linux, WSL2):

```bash
curl -fsSL https://raw.githubusercontent.com/PPROGER/vatra/main/install.sh | bash
```

The installer:

1. Checks git, tmux and a C/C++ toolchain, and offers to install missing ones via brew / apt / dnf / pacman / zypper.
2. Checks for Node.js 22+.
3. Clones Vatra into `~/.vatra-app` and builds it.
4. Puts a `vatra` command into `~/.local/bin`.

It asks before installing anything. Options: `--service` (start in the background at login), `--yes` (don't ask), `--dir <path>`, `--no-deps`.

Then:

```bash
claude                 # once: /login with your Pro/Max account
vatra start --open     # → http://localhost:4317
```

| Command | What it does |
|---|---|
| `vatra start [--open]` | start the server (UI at http://localhost:4317) |
| `vatra open` | open the UI in your browser |
| `vatra doctor` | check git, tmux, claude, gh and native modules |
| `vatra update` | `git pull`, install, build, restart the background service |
| `vatra install-service` / `uninstall-service` | run in the background (launchd / `systemd --user`) |

Manual install from a clone: `corepack pnpm install && corepack pnpm build && node dist/server/cli.js start`.

### Requirements

| | macOS | Linux |
|---|---|---|
| Node.js | 22+ (`brew install node` or nvm) | 22+ (nvm) |
| git, tmux | `brew install tmux` | `apt install git tmux` |
| compiler for node-pty / better-sqlite3 | Xcode Command Line Tools | `build-essential python3` |
| Claude Code | `npm i -g @anthropic-ai/claude-code`, then `claude` → `/login` | same |
| notifications | built in | `notify-send` (libnotify) |
| PRs (optional) | `brew install gh && gh auth login` | `apt install gh` |

## How it works

1. **Add a project.** Pick a git repository with the native folder dialog, the built-in browser, or from the list of repositories Vatra found. The setup script (from the lockfile) and `.env` files to copy are filled in automatically.
2. **New task = an empty chat.** Write what needs doing, attach files, press Enter. Vatra then:
   - runs `git worktree add -b agent/<slug>` from the base branch;
   - copies the env files and runs the setup script;
   - starts `claude "<your message>"` in tmux.

   The first line of your message becomes the task title.
3. **Chat** with the agent. It's the same interactive session you'd have in a terminal:
   - history is read from Claude Code's own transcript;
   - message statuses (sent → received → answered) and live "what the agent is doing";
   - every slash command works (`/compact`, `/clear`, `/review`, your own commands and skills), plus `@file` mentions, `!bash`, and attachments (paste screenshots, drag & drop);
   - context window usage;
   - permission prompts and the "trust this folder?" prompt get buttons right in the chat.

   A raw **Terminal** tab is always there for interactive menus.
4. **Diff** tab: everything vs. the base commit, only commits, or only uncommitted changes. Updates live.
5. **Finish the task.** The project setting picks which button is the main one:
   - **Create PR**: pushes the agent branch and opens a PR with `gh`. Without `gh`, it opens GitHub's "new pull request" page instead. Later pushes update the same PR. Once the PR is merged on GitHub, Vatra stops the agent and cleans up.
   - **Merge ▾**: merge or squash into the base branch, optionally followed by `git push`. Your current checkout is never switched; a temporary worktree is used when needed. On a conflict the merge is aborted and the agent is asked to rebase.
   - **Discard**: stops the agent and removes its worktree and branch.

Agents live in tmux sessions (`tmux -L vatra ls`), so restarting the server doesn't kill them. If an agent renames its branch (e.g. because your CLAUDE.md asks for `feat/...` names), Vatra follows it. Vatra only ever deletes branches the task itself created.

## Using it from another device

The server only listens on `127.0.0.1` on purpose: a terminal in the browser means running commands on that machine. To use Vatra running on another computer (a home Mac, a Linux box), forward the port over SSH:

```bash
ssh -N -L 4317:localhost:4317 user@host
# then open http://localhost:4317 locally
```

**Why no Docker image?** Vatra drives the `claude` CLI logged in with *your* subscription, your local repositories, your SSH keys and tmux on the host. Running it in a container would mean mounting all of that into it, so a native install is simpler and safer.

## Data & configuration

| | macOS | Linux |
|---|---|---|
| data directory | `~/.vatra` | `$XDG_DATA_HOME/vatra` (`~/.local/share/vatra`) |

`state.db` (SQLite), `worktrees/`, `logs/`, `uploads/`, `config.json`, `token`. Override the location with `VATRA_HOME`.

```json
{
  "port": 4317,
  "maxActive": 4,
  "portRange": [5100, 5199],
  "claudeBin": null,
  "claudeArgs": [],
  "contextWindow": 1000000,
  "tmuxSocket": "vatra"
}
```

- `maxActive`: how many agents can have a live session at once. All agents share your plan's limits; the rest wait in a queue.
- `portRange`: each task gets its own `PORT` env var so dev servers don't collide.
- `claudeArgs`: extra flags for every launch, e.g. `["--model", "opus"]`.
- `contextWindow`: size used for the context usage bar.

Vatra removes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the agents' environment so the CLI uses your subscription login instead of API billing. Check Anthropic's current usage policy for your plan.

## Troubleshooting

- **`posix_spawnp failed` on macOS**: node-pty's `spawn-helper` lost its executable bit. Run `corepack pnpm install` again; the postinstall step fixes it.
- **Build fails with node-gyp errors**: install the compiler (Xcode CLT / `build-essential python3`) and re-run the installer.
- **`claude` not found when running as a service**: Vatra looks in `PATH`, your login shell and common locations. Otherwise set `claudeBin` in `config.json`.
- **Many files on Linux**: raise the inotify limit, e.g. `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-inotify.conf && sudo sysctl --system`.
- **Port in use**: `VATRA_PORT=4318 vatra start` or set `port` in `config.json`.

## Uninstall

```bash
vatra uninstall-service
tmux -L vatra kill-server          # stop all agents
rm -rf ~/.vatra-app ~/.local/bin/vatra
rm -rf ~/.vatra                    # data: projects, tasks, worktrees, logs
```

## Development

```bash
git clone https://github.com/PPROGER/vatra.git && cd vatra
corepack pnpm install
corepack pnpm dev      # server with tsx watch + Vite on :5173 (the server prints the URL with a token)
corepack pnpm test     # git layer + end-to-end tests with real git/tmux and a fake claude
```

Stack: Node 22 + Fastify, node-pty + tmux, better-sqlite3 + Drizzle, React + Vite + Tailwind, xterm.js, diff2html.

## License

MIT
