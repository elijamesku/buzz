#!/usr/bin/env bash
#
# quickstart.sh — one command to stand up a local Buzz relay.
#
# Buzz's relay needs Postgres + Redis, which run in Docker. The only real
# friction for a new person is Docker itself; everything after that is already
# automated by `just setup`. This script closes that gap: it makes sure Docker
# is installed and running (assisting with the install when it can), then hands
# off to the existing setup. Safe to re-run.
#
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  \033[36m•\033[0m %s\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
err() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

confirm() {
  # Non-interactive (piped/CI): default to "no" so we never install silently.
  [[ -t 0 ]] || return 1
  local reply
  read -r -p "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

OS="$(uname -s)"

install_docker() {
  bold "Docker isn't installed."
  case "$OS" in
  Darwin)
    if command -v brew >/dev/null 2>&1; then
      if confirm "Install Docker Desktop with Homebrew now?"; then
        brew install --cask docker
        return 0
      fi
    fi
    warn "Install Docker Desktop for Mac, then re-run: just quickstart"
    info "Download: https://www.docker.com/products/docker-desktop/"
    command -v open >/dev/null 2>&1 &&
      confirm "Open the download page now?" && open "https://www.docker.com/products/docker-desktop/"
    return 1
    ;;
  Linux)
    warn "Docker Engine is required."
    if confirm "Install it now via the official get.docker.com script (uses sudo)?"; then
      curl -fsSL https://get.docker.com | sh
      return 0
    fi
    info "Manual install: https://docs.docker.com/engine/install/"
    return 1
    ;;
  *)
    err "Unsupported OS '$OS' — install Docker manually: https://docs.docker.com/get-docker/"
    return 1
    ;;
  esac
}

start_docker_daemon() {
  bold "Docker is installed but not running."
  case "$OS" in
  Darwin)
    info "Starting Docker Desktop…"
    open -a Docker >/dev/null 2>&1 || true
    ;;
  Linux)
    info "Try: sudo systemctl start docker"
    command -v systemctl >/dev/null 2>&1 && confirm "Start the docker service now (sudo)?" &&
      sudo systemctl start docker || true
    ;;
  esac
  info "Waiting for the Docker daemon (up to 90s)…"
  for _ in $(seq 1 45); do
    if docker info >/dev/null 2>&1; then
      ok "Docker daemon is up."
      return 0
    fi
    sleep 2
  done
  err "Docker daemon didn't come up. Start Docker, then re-run: just quickstart"
  return 1
}

bold "🐝 Buzz quickstart"

# 1. Docker present?
if ! command -v docker >/dev/null 2>&1; then
  install_docker || exit 1
fi
command -v docker >/dev/null 2>&1 || {
  err "Docker still not on PATH — open a new terminal and re-run: just quickstart"
  exit 1
}
ok "Docker is installed."

# 2. Docker daemon running?
if ! docker info >/dev/null 2>&1; then
  start_docker_daemon || exit 1
else
  ok "Docker daemon is running."
fi

# 3. Hand off to the existing setup (Docker services + migrations + deps).
bold "Bringing up Postgres + Redis and running migrations…"
./scripts/dev-setup.sh

# 4. Done.
echo
bold "✅ Buzz is ready."
info "Start the full app (relay + desktop):   just dev"
info "Or just the relay (ws://localhost:3000): just relay"
info "Your agents publish metrics here; open an agent's profile to watch them."
