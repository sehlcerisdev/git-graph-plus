#!/usr/bin/env bash
#
# Manage the Git Graph Plus standalone web server as a systemd *user* service.
#
#   scripts/service.sh install     build, create .env (if missing), install + start the service
#   scripts/service.sh uninstall   stop, disable, and remove the service (leaves .env + build)
#   scripts/service.sh restart      restart the running service
#   scripts/service.sh status       show service status
#   scripts/service.sh logs         follow the service logs (journalctl -f)
#
# Why a *user* service (not system): git operations must run as you, so they
# pick up your git credential helpers / `gh auth setup-git` / SSH agent — no
# credentials are stored by the app. The service-environment gotchas this script
# handles: (1) systemd user services get a minimal PATH, but git is spawned as
# bare `git` and invokes the `gh` credential helper via PATH, so we bake a real
# PATH (node + git + gh + your interactive PATH) into the unit; (2) the server
# loads `.env` from its working directory, so WorkingDirectory is pinned to the
# project root; (3) `~/projects` resolves via $HOME, which we set explicitly; and
# (4) linger is enabled so the server keeps running after you disconnect SSH.

set -euo pipefail

SERVICE_NAME="git-graph-plus"
UNIT="${SERVICE_NAME}.service"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="${UNIT_DIR}/${UNIT}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_systemd_user() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found; this script needs systemd."
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    die "Cannot reach the systemd *user* manager. Over SSH this often means no user session is running. Try: 'sudo loginctl enable-linger $USER' then reconnect, or 'export XDG_RUNTIME_DIR=/run/user/\$(id -u)' before re-running."
  fi
}

# Read a value from .env (best-effort), falling back to a default.
get_env() {
  local key="$1" default="${2:-}" val=""
  if [ -f "${PROJECT_DIR}/.env" ]; then
    val="$(grep -E "^[[:space:]]*${key}=" "${PROJECT_DIR}/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")" || true
  fi
  printf '%s' "${val:-$default}"
}

build() {
  log "Building (installing dependencies if missing)…"
  [ -d "${PROJECT_DIR}/node_modules" ] || ( cd "$PROJECT_DIR" && npm install )
  [ -d "${PROJECT_DIR}/webview-ui/node_modules" ] || ( cd "${PROJECT_DIR}/webview-ui" && npm install )
  ( cd "$PROJECT_DIR" && npm run build && npm run build:server )
  [ -f "${PROJECT_DIR}/dist/server.js" ] || die "Build did not produce dist/server.js"
}

ensure_env() {
  if [ -f "${PROJECT_DIR}/.env" ]; then
    log ".env already exists — leaving it untouched."
  elif [ -f "${PROJECT_DIR}/.env.example" ]; then
    cp "${PROJECT_DIR}/.env.example" "${PROJECT_DIR}/.env"
    log "Created .env from .env.example — review ROOT_DIR / AUTH_TOKEN / PORT before relying on it."
  else
    warn ".env.example not found; the server will start with built-in defaults."
  fi
}

# Resolve a *stable* node executable path for the unit file.
#
# `command -v node` under fnm points at an ephemeral per-shell symlink like
# /run/user/1000/fnm_multishells/<pid>_<ts>/bin/node, which is deleted when the
# shell exits — baking that into ExecStart makes the service fail with 203/EXEC.
# Prefer fnm's `default` alias ($FNM_DIR/aliases/default/bin/node): it's a stable
# symlink that fnm re-points whenever you run `fnm default <version>`, so the
# service keeps working across node upgrades. Fall back to `readlink -f` (the
# version-specific install dir) and finally the raw path.
resolve_node_bin() {
  local current fnm_dir candidate
  current="$(command -v node 2>/dev/null)" || return 1

  if [[ "$current" == *"/fnm_multishells/"* ]]; then
    fnm_dir="${FNM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/fnm}"
    for candidate in "${fnm_dir}/aliases/default/bin/node" "$HOME/.fnm/aliases/default/bin/node"; do
      if [ -x "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
      fi
    done
    warn "node resolved to an ephemeral fnm multishell path and no fnm 'default' alias was found."
    warn "Run 'fnm default \$(fnm current)' to pin a default, then re-run install. Falling back to the resolved install path."
  fi

  # Resolve symlinks to the concrete install (stable as long as that version exists).
  readlink -f "$current" 2>/dev/null || printf '%s' "$current"
}

write_unit() {
  local node_bin svc_path git_bin gh_bin
  node_bin="$(resolve_node_bin)" || die "node not found on PATH."
  log "Using node: ${node_bin}"

  # Compose a PATH the service can use: node's dir + git's dir + gh's dir + the
  # current interactive PATH (covers nvm, /usr/local/bin, ~/.local/bin, etc.).
  svc_path="$(dirname "$node_bin")"
  if git_bin="$(command -v git 2>/dev/null)"; then
    svc_path="${svc_path}:$(dirname "$git_bin")"
  else
    warn "git is not on PATH right now; git operations will fail unless GIT_BINARY_PATH is set in .env."
  fi
  if gh_bin="$(command -v gh 2>/dev/null)"; then
    svc_path="${svc_path}:$(dirname "$gh_bin")"
  fi
  svc_path="${svc_path}:${PATH}"

  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Git Graph Plus standalone web server
Documentation=file://${PROJECT_DIR}/SERVER.md
After=default.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${node_bin} ${PROJECT_DIR}/dist/server.js
Environment=NODE_ENV=production
Environment=HOME=%h
Environment=PATH=${svc_path}
Environment=GIT_TERMINAL_PROMPT=0
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  log "Wrote unit: ${UNIT_PATH}"
}

enable_linger() {
  if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    log "Linger already enabled (service survives logout)."
  elif loginctl enable-linger "$USER" 2>/dev/null; then
    log "Enabled linger (service survives logout)."
  else
    warn "Could not enable linger automatically. To keep the server running after you disconnect, run: sudo loginctl enable-linger $USER"
  fi
}

print_access_hint() {
  local host port
  host="$(get_env HOST 127.0.0.1)"
  port="$(get_env PORT 8080)"
  log "Listening on ${host}:${port}."
  log "From your workstation:  ssh -L ${port}:localhost:${port} $(hostname)  then open  http://localhost:${port}"
}

install_service() {
  require_systemd_user
  build
  ensure_env
  write_unit
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  enable_linger
  log "Installed and started."
  print_access_hint
  echo
  systemctl --user --no-pager status "$UNIT" || true
}

uninstall_service() {
  require_systemd_user
  systemctl --user disable --now "$UNIT" 2>/dev/null || systemctl --user stop "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload
  log "Uninstalled the service. Your .env and build output were left in place."
}

case "${1:-}" in
  install)          install_service ;;
  uninstall|remove) uninstall_service ;;
  restart)          require_systemd_user; systemctl --user restart "$UNIT"; log "Restarted." ;;
  status)           require_systemd_user; systemctl --user --no-pager status "$UNIT" ;;
  logs)             require_systemd_user; journalctl --user -u "$UNIT" -f ;;
  *)
    echo "Usage: $0 {install|uninstall|restart|status|logs}" >&2
    exit 1
    ;;
esac
