#!/usr/bin/env bash
#
# chrome-bridge bootstrap installer
#
# Usage:
#   curl -fsSL https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.sh | bash
#   curl -fsSL https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.sh | bash -s -- -h
#   curl -fsSL https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.sh | bash -s -- --no-start
#   curl -fsSL https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.sh | bash -s -- --no-skill
#
# What it does:
#   1. Detect OS/arch (macOS / Linux; arm64 / amd64)
#   2. Download binary from GitHub to ~/.chrome-bridge/bin/chrome-bridge and chmod +x
#   3. Start the daemon (unless --no-start)
#   4. Install skills to detected AI agent runtimes (unless --no-skill)

set -euo pipefail

# ---------- config ----------

GITHUB_REPO="zhaocore/chrome-bridge-api"
GITHUB_REF="master"
BASE_URL="https://github.com/${GITHUB_REPO}/raw/refs/heads/${GITHUB_REF}"
INSTALL_DIR="$HOME/.chrome-bridge"
BIN_DIR="$INSTALL_DIR/bin"
BIN_PATH="$BIN_DIR/chrome-bridge"

# ---------- output ----------

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; N=""
fi

info() { printf "%s==>%s %s\n" "$B" "$N" "$*"; }
ok()   { printf "%s✓%s %s\n" "$G" "$N" "$*"; }
warn() { printf "%s!%s %s\n" "$Y" "$N" "$*" >&2; }
err()  { printf "%s✗%s %s\n" "$R" "$N" "$*" >&2; }

show_help() {
  cat <<EOF
chrome-bridge bootstrap installer

Usage:
  curl -fsSL $BASE_URL/bin/install.sh | bash                  # latest (master)
  curl -fsSL $BASE_URL/bin/install.sh | bash -s -- --no-start # skip daemon start
  curl -fsSL $BASE_URL/bin/install.sh | bash -s -- --no-skill # skip skill install

Options:
  -h, --help       Show this help.
  --no-start       Install binary and skills, but don't start the daemon.
  --no-skill       Install binary and start the daemon, but skip skill installation.

What it does:
  1. Detect OS/arch (macOS / Linux; arm64 / amd64)
  2. Download chrome-bridge binary from GitHub to $BIN_PATH
  3. Start the daemon (unless --no-start)
  4. Install skills to detected AI-agent runtimes (unless --no-skill)
EOF
}

# ---------- args ----------

NO_START=0
NO_SKILL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)   show_help; exit 0 ;;
    --no-start)  NO_START=1; shift ;;
    --no-skill)  NO_SKILL=1; shift ;;
    *) err "unknown option: $1"; echo; show_help >&2; exit 2 ;;
  esac
done

# ---------- prerequisites ----------

for cmd in curl mktemp uname; do
  command -v "$cmd" >/dev/null 2>&1 || { err "required command not found: $cmd"; exit 1; }
done

# ---------- detect OS/arch ----------

info "Detecting OS/arch..."
case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) err "unsupported OS: $(uname -s). Supported: macOS, Linux."; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="amd64" ;;
  *) err "unsupported arch: $(uname -m). Supported: arm64, amd64."; exit 1 ;;
esac

PLATFORM="$OS-$ARCH"
ok "Platform: $PLATFORM"

# ---------- download binary ----------

# Binaries are committed directly to the repo under bin/.
# e.g. https://github.com/zhaocore/chrome-bridge-api/raw/refs/heads/master/bin/chrome-bridge-darwin-arm64
BIN_URL="$BASE_URL/bin/chrome-bridge-$PLATFORM"
info "Downloading binary from $BIN_URL"
mkdir -p "$BIN_DIR"
TMP_BIN=$(mktemp "${TMPDIR:-/tmp}/chrome-bridge.XXXXXX")
if ! curl -fsSL --retry 3 --connect-timeout 10 -o "$TMP_BIN" "$BIN_URL"; then
  err "failed to download binary"
  rm -f "$TMP_BIN"
  exit 1
fi
mv "$TMP_BIN" "$BIN_PATH"
chmod +x "$BIN_PATH"
ok "Installed to $BIN_PATH"

# ---------- start daemon ----------

if [ "$NO_START" -eq 0 ]; then
  info "Starting daemon..."
  if "$BIN_PATH" start; then
    ok "Daemon started"
  else
    warn "Daemon failed to start — check logs at $INSTALL_DIR/logs/daemon.log"
  fi
else
  info "Skipping daemon start (--no-start)"
fi

# ---------- install skill ----------

if [ "$NO_SKILL" -eq 0 ]; then
  info "Installing skills..."
  if "$BIN_PATH" install-skill -y; then
    ok "Skills installed"
  else
    warn "Some skill installations failed"
  fi
else
  info "Skipping skill install (--no-skill)"
fi

printf "\n%sDone.%s Check status anytime: %schrome-bridge status%s\n\n" "$G" "$N" "$B" "$N"
