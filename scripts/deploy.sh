#!/usr/bin/env bash
# Runs ON the RankSmith host. Brings the checkout to origin/main, installs, restarts.
#
# A restart kills any agent process mid-Phase; the Engine resumes stranded Jobs at boot,
# but the Phase starts over. So wait for the agent queue to drain first, up to a limit.
set -euo pipefail

REPO="${RANKSMITH_REPO:-$HOME/projects/ranksmith}"
SERVICE="${RANKSMITH_SERVICE:-ranksmith}"
WAIT_LIMIT_S="${RANKSMITH_DEPLOY_WAIT:-900}"

cd "$REPO"
before=$(git rev-parse --short HEAD)
git fetch --prune origin
git reset --hard origin/main --quiet
after=$(git rev-parse --short HEAD)
echo "checkout: $before -> $after"

npm ci --no-audit --no-fund --loglevel=error

# Agent phases are child processes of the service: claude or codex, launched by the Engine.
agent_running() {
  local main_pid
  main_pid=$(systemctl show -p MainPID --value "$SERVICE")
  [ "${main_pid:-0}" != "0" ] && pgrep -P "$main_pid" -f 'claude|codex' >/dev/null
}

waited=0
while agent_running && [ "$waited" -lt "$WAIT_LIMIT_S" ]; do
  [ "$waited" -eq 0 ] && echo "an agent phase is running; waiting up to ${WAIT_LIMIT_S}s for it to finish"
  sleep 15
  waited=$((waited + 15))
done
if agent_running; then
  echo "still running after ${WAIT_LIMIT_S}s; restarting anyway (the Engine will resume the Job)"
fi

sudo systemctl restart "$SERVICE"
sleep 5
systemctl is-active --quiet "$SERVICE" || {
  echo "$SERVICE did not come up:" >&2
  journalctl -u "$SERVICE" -n 40 --no-pager >&2
  exit 1
}
echo "$SERVICE is active at $after"
journalctl -u "$SERVICE" -n 10 --no-pager
