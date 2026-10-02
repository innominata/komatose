#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3847}"
HOST="${HOST:-127.0.0.1}"
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a
  source .env
  set +a
  PORT="${PORT:-3847}"
  HOST="${HOST:-127.0.0.1}"
fi

# systemd-run starts with a minimal PATH; the app service does too.
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

LOG_DIR="$ROOT/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/production.log"
PID_FILE="$LOG_DIR/production.pid"
STATUS_FILE="$LOG_DIR/rebuild.status"
LOCK_FILE="$LOG_DIR/rebuild.lock"
SYSTEMD_UNIT="${SCAN_SYSTEMD_UNIT:-scan.service}"

# Stopping scan.service with the default cgroup KillMode also kills GPU llama-server
# and Hayai. Jump to a transient unit first, then stop only the Svelte/Node process.
if [[ -z "${SCAN_REBUILD_ESCAPED:-}" ]] && grep -q 'scan.service' /proc/self/cgroup 2>/dev/null; then
  echo "Re-launching rebuild outside ${SYSTEMD_UNIT}…" | tee -a "$LOG_FILE"
  sudo systemctl reset-failed scan-rebuild.service 2>/dev/null || true
  sudo systemctl stop scan-rebuild.service 2>/dev/null || true
  exec sudo systemd-run --collect --no-block --quiet \
    --uid="$(id -u)" --gid="$(id -g)" \
    --working-directory="$ROOT" \
    --unit=scan-rebuild \
    --setenv=SCAN_REBUILD_ESCAPED=1 \
    --setenv=HOME="$HOME" \
    --setenv=PATH="$PATH" \
    /bin/bash "$ROOT/scripts/rebuild.sh"
fi

need_start=0

start_server() {
  if systemctl cat "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    echo "Starting ${SYSTEMD_UNIT}…" | tee -a "$LOG_FILE"
    sudo systemctl reset-failed "$SYSTEMD_UNIT" 2>/dev/null || true
    sudo systemctl start "$SYSTEMD_UNIT"
    need_start=0
    return 0
  fi
  nohup npm start >>"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"
  need_start=0
}

mark_failed() {
  echo failed >"$STATUS_FILE"
}

on_exit() {
  local code=$?
  if [[ "$need_start" == 1 ]]; then
    start_server || true
  fi
  if [[ "$code" -ne 0 ]]; then
    mark_failed
  fi
}
trap on_exit EXIT

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "A rebuild is already running." | tee -a "$LOG_FILE" >&2
  exit 1
fi

echo started >"$STATUS_FILE"

listening_pids() {
  # grep exits 1 when the port is free; keep going under `set -e -o pipefail`.
  ss -lptn "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}

# systemd default KillMode=mixed SIGKILLs the whole cgroup after stop timeout,
# which unloads Qwen / Paddle / Hayai. stop.conf in this unit currently forces
# mixed and sorts after keep-inference.conf, so a later drop-in must win.
ensure_svelte_only_stop() {
  if ! systemctl cat "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    return 0
  fi
  local drop_dir="/etc/systemd/system/${SYSTEMD_UNIT}.d"
  local drop="$drop_dir/zz-keep-inference.conf"
  local mode
  mode="$(systemctl show -p KillMode --value "$SYSTEMD_UNIT" 2>/dev/null || true)"
  if [[ "$mode" == "process" ]]; then
    return 0
  fi
  echo "Setting ${SYSTEMD_UNIT} KillMode=process so GPU inference survives rebuilds…" | tee -a "$LOG_FILE"
  sudo mkdir -p "$drop_dir"
  printf '%s\n' '[Service]' 'KillMode=process' | sudo tee "$drop" >/dev/null
  # stop.conf currently ends with KillMode=mixed and would override an earlier drop-in.
  if [[ -f "$drop_dir/stop.conf" ]] && grep -q '^KillMode=' "$drop_dir/stop.conf"; then
    sudo sed -i '/^KillMode=/d' "$drop_dir/stop.conf"
  fi
  sudo rm -f "$drop_dir/keep-inference.conf"
  sudo systemctl daemon-reload
  mode="$(systemctl show -p KillMode --value "$SYSTEMD_UNIT" 2>/dev/null || true)"
  if [[ "$mode" != "process" ]]; then
    echo "KillMode is still ${mode:-unknown}; GPU engines may unload on stop." | tee -a "$LOG_FILE" >&2
  fi
}

# llama-server/Hayai are still in scan.service's cgroup. Move them out before
# `systemctl stop` so even KillMode=mixed cannot SIGKILL them.
evac_inference() {
  local cgroup="/sys/fs/cgroup/system.slice/${SYSTEMD_UNIT}"
  local parent="/sys/fs/cgroup/system.slice"
  local pid cmd kept=""
  while read -r pid; do
    [[ -n "$pid" && "$pid" != "0" ]] || continue
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    if [[ "$cmd" == *llama-server* || "$cmd" == *hayai_review.py* || "$cmd" == *sd-server* ]]; then
      if echo "$pid" | sudo tee "$parent/cgroup.procs" >/dev/null 2>&1; then
        kept+="$pid "
      fi
    fi
  done < <(sudo cat "$cgroup/cgroup.procs" 2>/dev/null || true)
  if [[ -n "$kept" ]]; then
    echo "Left GPU inference running outside ${SYSTEMD_UNIT}: $kept" | tee -a "$LOG_FILE"
  fi
}

stop_svelte_pids() {
  local pids="$1"
  [[ -z "$pids" ]] && return 0
  echo "Stopping Svelte server on ${HOST}:${PORT} (pids ${pids//$'\n'/ })…" | tee -a "$LOG_FILE"
  # SIGKILL the HTTP process so an older Node SIGTERM handler cannot tear down llama-server.
  for pid in $pids; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

stop_server() {
  need_start=1
  if systemctl cat "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    ensure_svelte_only_stop
    echo "Stopping ${SYSTEMD_UNIT} without unloading GPU inference…" | tee -a "$LOG_FILE"
    local pids main
    pids="$(listening_pids)"
    main="$(systemctl show -p MainPID --value "$SYSTEMD_UNIT" 2>/dev/null || true)"
    sudo systemctl kill --kill-whom=main -s SIGKILL "$SYSTEMD_UNIT" 2>/dev/null || true
    if [[ -n "$main" && "$main" != "0" ]]; then
      pids="$(printf '%s\n%s\n' "$pids" "$main" | awk 'NF && $1 != "0"' | sort -u)"
    fi
    stop_svelte_pids "$pids"
    for _ in 1 2 3 4 5 6 7 8; do
      [[ -z "$(listening_pids)" ]] && break
      sleep 0.5
    done
    if [[ -n "$(listening_pids)" ]]; then
      echo "Forcing remaining Svelte listeners off ${PORT}…" | tee -a "$LOG_FILE"
      stop_svelte_pids "$(listening_pids)"
      sleep 0.5
    fi
    evac_inference
    sudo systemctl stop "$SYSTEMD_UNIT" 2>/dev/null || true
    sudo systemctl reset-failed "$SYSTEMD_UNIT" 2>/dev/null || true
    rm -f "$PID_FILE"
    return 0
  fi
  local pids
  pids="$(listening_pids)"
  if [[ -f "$PID_FILE" ]]; then
    pids="$(printf '%s\n%s\n' "$pids" "$(cat "$PID_FILE" 2>/dev/null || true)" | awk 'NF' | sort -u)"
  fi
  if [[ -z "$pids" ]]; then
    rm -f "$PID_FILE"
    return 0
  fi
  stop_svelte_pids "$pids"
  for _ in 1 2 3 4 5 6 7 8; do
    [[ -z "$(listening_pids)" ]] && break
    sleep 0.5
  done
  pids="$(listening_pids)"
  if [[ -n "$pids" ]]; then
    echo "Forcing remaining Svelte listeners: ${pids//$'\n'/ }" | tee -a "$LOG_FILE"
    stop_svelte_pids "$pids"
    sleep 0.5
  fi
  rm -f "$PID_FILE"
}

wait_for_server() {
  local url="http://${HOST}:${PORT}/login"
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null "$url"; then
      echo "Production is up at $url (${i}s)" | tee -a "$LOG_FILE"
      return 0
    fi
    sleep 1
  done
  echo "Production did not respond on $url within 30s." | tee -a "$LOG_FILE" >&2
  echo "Check $LOG_FILE for errors." >&2
  return 1
}

echo "Stopping the Svelte app so the build can replace files; GPU inference stays loaded…" | tee -a "$LOG_FILE"
stop_server

echo "Building Komatose…" | tee -a "$LOG_FILE"
npm run build >>"$LOG_FILE" 2>&1

echo "Starting production server…" | tee -a "$LOG_FILE"
start_server

wait_for_server
echo ready >"$STATUS_FILE"
echo "Log: $LOG_FILE"
