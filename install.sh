#!/usr/bin/env bash
# Ватра (vatra) installer — macOS and Linux (incl. WSL2).
#
#   curl -fsSL https://raw.githubusercontent.com/PPROGER/vatra/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/PPROGER/vatra/main/install.sh | bash -s -- --service
#
# Options:
#   --dir <path>     where to install (default: ~/.vatra-app, or $VATRA_DIR)
#   --service        start Vatra in the background at login (launchd / systemd --user)
#   --yes, -y        install missing system packages without asking
#   --no-deps        don't try to install system packages, only check them
#   --branch <name>  git branch to install (default: main)
#
# Environment: VATRA_REPO (git URL), VATRA_DIR, VATRA_BIN_DIR (default ~/.local/bin).
set -euo pipefail

REPO="${VATRA_REPO:-https://github.com/PPROGER/vatra.git}"
DIR="${VATRA_DIR:-$HOME/.vatra-app}"
BIN_DIR="${VATRA_BIN_DIR:-$HOME/.local/bin}"
BRANCH="main"
SERVICE=0
YES=0
DEPS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --no-deps) DEPS=0; shift ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; O=$'\033[38;5;208m'; N=$'\033[0m'
else
  B=''; DIM=''; R=''; G=''; Y=''; O=''; N=''
fi
# Ukrainian for uk/ru locales, English otherwise (or VATRA_LANG=uk|en)
case "${VATRA_LANG:-${LC_ALL:-${LANG:-}}}" in uk*|ru*) UK=1 ;; *) UK=0 ;; esac
L() { if [ "$UK" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$O$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask y/N even when the script itself is piped into bash.
ask() {
  [ "$YES" = 1 ] && return 0
  local answer=""
  if [ -r /dev/tty ]; then
    printf '  %s [y/N] ' "$1" > /dev/tty
    read -r answer < /dev/tty || true
  fi
  case "$answer" in y|Y|yes|так|Так) return 0 ;; *) return 1 ;; esac
}

say "${O}${B}🔥 $(L "Ватра" "Vatra")${N} ${DIM}— $(L "паралельні агенти Claude Code в git worktrees" "parallel Claude Code agents in git worktrees")${N}"

# ------------------------------------------------------------------ platform
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux)  PLATFORM=linux ;;
  *) die "$(L "Підтримуються macOS і Linux (Windows — через WSL2). Зараз: $OS" "Only macOS and Linux are supported (Windows via WSL2). This is: $OS")" ;;
esac

PM=""
if [ "$PLATFORM" = mac ]; then
  have brew && PM=brew
else
  for p in apt-get dnf pacman zypper; do have "$p" && { PM="$p"; break; }; done
fi

SUDO=""
if [ "$(id -u)" != 0 ] && have sudo; then SUDO="sudo"; fi

pkg_install() {
  # $@ = package names for the detected package manager
  case "$PM" in
    brew)    brew install "$@" ;;
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y "$@" ;;
    dnf)     $SUDO dnf install -y "$@" ;;
    pacman)  $SUDO pacman -S --needed --noconfirm "$@" ;;
    zypper)  $SUDO zypper install -y "$@" ;;
    *) return 1 ;;
  esac
}

need_pkg() {
  # need_pkg <command> <human name> <brew pkg> <apt pkg> <dnf pkg> <pacman pkg> <zypper pkg>
  local cmd="$1" name="$2"
  if have "$cmd"; then ok "$name"; return; fi
  local pkg=""
  case "$PM" in
    brew) pkg="$3" ;; apt-get) pkg="$4" ;; dnf) pkg="$5" ;; pacman) pkg="$6" ;; zypper) pkg="$7" ;;
  esac
  if [ "$DEPS" = 1 ] && [ -n "$pkg" ] && ask "$(L "Немає $name. Встановити через $PM ($pkg)?" "$name is missing. Install it with $PM ($pkg)?")"; then
    pkg_install "$pkg" || die "$(L "Не вдалося встановити $name" "Could not install $name")"
    if have "$cmd"; then ok "$name"; else die "$(L "$name так і не зʼявився в PATH" "$name is still not on PATH")"; fi
  else
    die "$(L "Потрібен $name. Встанови його${pkg:+ ($PM: $pkg)} і запусти інсталятор ще раз." "$name is required. Install it${pkg:+ ($PM: $pkg)} and run the installer again.")"
  fi
}

# ------------------------------------------------------------------ dependencies
step "$(L "Перевіряю залежності" "Checking dependencies")"

need_pkg git  "git"  git git git git git
need_pkg tmux "tmux" tmux tmux tmux tmux tmux
need_pkg curl "curl" curl curl curl curl curl

# compiler for node-pty / better-sqlite3 (when no prebuilt binary fits)
if [ "$PLATFORM" = mac ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools"
  else
    warn "$(L "Немає Xcode Command Line Tools — відкриваю встановлення. Після завершення запусти інсталятор ще раз." "Xcode Command Line Tools are missing — opening the installer. Run this script again when it finishes.")"
    xcode-select --install || true
    exit 1
  fi
else
  need_pkg python3 "python3" python3 python3 python3 python python3
  need_pkg make "make" make build-essential make base-devel make
  need_pkg g++ "$(L "C++ компілятор" "C++ compiler")" gcc build-essential gcc-c++ base-devel gcc-c++
fi

# Node.js 22+
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! have node || [ "$(node_major)" -lt 22 ]; then
  if have node; then current="$(node -v)"; else current="$(L 'немає' 'none')"; fi
  if [ "$PM" = brew ] && [ "$DEPS" = 1 ] && ask "$(L "Потрібен Node.js 22+ (зараз: $current). Встановити через brew?" "Node.js 22+ is required (found: $current). Install it with brew?")"; then
    brew install node
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    warn "$(L "Потрібен Node.js 22+ (зараз: $current) — ставлю через nvm" "Node.js 22+ is required (found: $current) — installing with nvm")"
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 >/dev/null
    nvm use 22 >/dev/null
  else
    die "$(L "Потрібен Node.js 22+ (зараз: $current). Найпростіше через nvm:" "Node.js 22+ is required (found: $current). The easiest way is nvm:")
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      nvm install 22
    $(L "і запусти інсталятор ще раз." "then run this installer again.")"
  fi
fi
ok "Node.js $(node -v)"
have corepack || die "$(L "Немає corepack (йде разом з Node.js 22). Перевстанови Node.js." "corepack is missing (it ships with Node.js 22). Reinstall Node.js.")"
ok "$(L "corepack (pnpm буде завантажено автоматично)" "corepack (pnpm is downloaded automatically)")"

# ------------------------------------------------------------------ source
step "$(L "Код" "Source") → $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" pull --quiet --ff-only origin "$BRANCH"
  ok "$(L "оновлено" "updated") ($(git -C "$DIR" rev-parse --short HEAD))"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$(L "$DIR уже існує і це не git-клон Ватри. Вкажи іншу папку: --dir <шлях>" "$DIR already exists and is not a Vatra clone. Choose another folder: --dir <path>")"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
  ok "$(L "склоновано" "cloned") ($(git -C "$DIR" rev-parse --short HEAD))"
fi

# ------------------------------------------------------------------ build
step "$(L "Встановлюю залежності і збираю" "Installing dependencies and building")"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
(
  cd "$DIR"
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
) || die "$(L "Збірка не вдалася. Вивід вище; найчастіше бракує компілятора (див. README → Troubleshooting)." "The build failed. See the output above; usually a compiler is missing (README → Troubleshooting).")"
ok "$(L "зібрано" "built")"

# ------------------------------------------------------------------ command
step "$(L "Команда" "Command") vatra → $BIN_DIR/vatra"
mkdir -p "$BIN_DIR"
NODE_BIN="$(command -v node)"
cat > "$BIN_DIR/vatra" <<EOF
#!/usr/bin/env bash
# Generated by the Vatra installer.
exec "$NODE_BIN" "$DIR/dist/server/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/vatra"
ok "vatra $("$BIN_DIR/vatra" version)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    SHELL_RC="$HOME/.profile"
    case "${SHELL:-}" in */zsh) SHELL_RC="$HOME/.zshrc" ;; */bash) SHELL_RC="$HOME/.bashrc" ;; esac
    warn "$(L "$BIN_DIR немає в PATH. Додай у $SHELL_RC:" "$BIN_DIR is not on your PATH. Add this to $SHELL_RC:")"
    say  "      export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# ------------------------------------------------------------------ claude & gh
step "Claude Code"
if have claude; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
  say "  ${DIM}$(L "Якщо ще не входив: запусти" "If you haven't yet: run") ${N}claude${DIM} $(L "і виконай" "and do") ${N}/login${DIM} $(L "(підписка Pro/Max)." "(Pro/Max plan).")${N}"
else
  warn "$(L "claude не знайдено. Встанови Claude Code:" "claude not found. Install Claude Code:")"
  say  "      npm install -g @anthropic-ai/claude-code"
  say  "    $(L "потім запусти claude і виконай /login" "then run claude and do /login")"
fi
if have gh; then ok "gh ($(L "для PR" "for PRs"))"; else warn "$(L "gh не встановлено — PR відкриватимуться через сторінку GitHub (необовʼязково: brew install gh / apt install gh, потім gh auth login)" "gh is not installed — PRs will open via the GitHub page (optional: brew install gh / apt install gh, then gh auth login)")"; fi

# ------------------------------------------------------------------ run
if [ "$SERVICE" = 1 ]; then
  step "$(L "Автозапуск" "Background service")"
  "$BIN_DIR/vatra" install-service
fi

say ""
say "${G}${B}$(L "Готово." "Done.")${N}"
if [ "$SERVICE" = 1 ]; then
  say "  $(L "Ватра працює у фоні:" "Vatra is running in the background:") ${B}http://localhost:4317${N}  (vatra open)"
else
  say "  $(L "Запуск:     " "Start:      ") ${B}vatra start --open${N}"
  say "  $(L "У фоні:     " "Background: ") ${B}vatra install-service${N}"
fi
say "  $(L "Оновлення:  " "Update:     ") ${B}vatra update${N}"
say "  $(L "Перевірка:  " "Check:      ") ${B}vatra doctor${N}  ·  vatra selftest"
