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

say "${O}${B}🔥 Ватра${N} ${DIM}— паралельні агенти Claude Code в git worktrees${N}"

# ------------------------------------------------------------------ platform
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux)  PLATFORM=linux ;;
  *) die "Підтримуються macOS і Linux (Windows — через WSL2). Зараз: $OS" ;;
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
  if [ "$DEPS" = 1 ] && [ -n "$pkg" ] && ask "Немає $name. Встановити через $PM ($pkg)?"; then
    pkg_install "$pkg" || die "Не вдалося встановити $name"
    if have "$cmd"; then ok "$name"; else die "$name так і не зʼявився в PATH"; fi
  else
    die "Потрібен $name. Встанови його${pkg:+ ($PM: $pkg)} і запусти інсталятор ще раз."
  fi
}

# ------------------------------------------------------------------ dependencies
step "Перевіряю залежності"

need_pkg git  "git"  git git git git git
need_pkg tmux "tmux" tmux tmux tmux tmux tmux
need_pkg curl "curl" curl curl curl curl curl

# compiler for node-pty / better-sqlite3 (when no prebuilt binary fits)
if [ "$PLATFORM" = mac ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools"
  else
    warn "Немає Xcode Command Line Tools — відкриваю встановлення. Після завершення запусти інсталятор ще раз."
    xcode-select --install || true
    exit 1
  fi
else
  need_pkg python3 "python3" python3 python3 python3 python python3
  need_pkg make "make" make build-essential make base-devel make
  need_pkg g++ "C++ компілятор" gcc build-essential gcc-c++ base-devel gcc-c++
fi

# Node.js 22+
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! have node || [ "$(node_major)" -lt 22 ]; then
  current="$(have node && node -v || echo 'немає')"
  if [ "$PM" = brew ] && [ "$DEPS" = 1 ] && ask "Потрібен Node.js 22+ (зараз: $current). Встановити через brew?"; then
    brew install node
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    warn "Потрібен Node.js 22+ (зараз: $current) — ставлю через nvm"
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 >/dev/null
    nvm use 22 >/dev/null
  else
    die "Потрібен Node.js 22+ (зараз: $current).
    Найпростіше через nvm:
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      nvm install 22
    і запусти інсталятор ще раз."
  fi
fi
ok "Node.js $(node -v)"
have corepack || die "Немає corepack (йде разом з Node.js 22). Перевстанови Node.js."
ok "corepack (pnpm буде завантажено автоматично)"

# ------------------------------------------------------------------ source
step "Код → $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" pull --quiet --ff-only origin "$BRANCH"
  ok "оновлено ($(git -C "$DIR" rev-parse --short HEAD))"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR уже існує і це не git-клон Ватри. Вкажи іншу папку: --dir <шлях>"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
  ok "склоновано ($(git -C "$DIR" rev-parse --short HEAD))"
fi

# ------------------------------------------------------------------ build
step "Встановлюю залежності і збираю"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
(
  cd "$DIR"
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
) || die "Збірка не вдалася. Вивід вище; найчастіше бракує компілятора (див. README → Troubleshooting)."
ok "зібрано"

# ------------------------------------------------------------------ command
step "Команда vatra → $BIN_DIR/vatra"
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
    warn "$BIN_DIR немає в PATH. Додай у $SHELL_RC:"
    say  "      export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# ------------------------------------------------------------------ claude & gh
step "Claude Code"
if have claude; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
  say "  ${DIM}Якщо ще не входив: запусти ${N}claude${DIM} і виконай ${N}/login${DIM} (підписка Pro/Max).${N}"
else
  warn "claude не знайдено. Встанови Claude Code:"
  say  "      npm install -g @anthropic-ai/claude-code"
  say  "    потім запусти claude і виконай /login"
fi
if have gh; then ok "gh (для PR)"; else warn "gh не встановлено — PR відкриватимуться через сторінку GitHub (необовʼязково: brew install gh / apt install gh, потім gh auth login)"; fi

# ------------------------------------------------------------------ run
if [ "$SERVICE" = 1 ]; then
  step "Автозапуск"
  "$BIN_DIR/vatra" install-service
fi

say ""
say "${G}${B}Готово.${N}"
if [ "$SERVICE" = 1 ]; then
  say "  Ватра працює у фоні: ${B}http://localhost:4317${N}  (vatra open)"
else
  say "  Запуск:      ${B}vatra start --open${N}"
  say "  У фоні:      ${B}vatra install-service${N}"
fi
say "  Оновлення:   ${B}vatra update${N}"
say "  Перевірка:   ${B}vatra doctor${N}"
