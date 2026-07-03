#!/usr/bin/env bash
# Runs /fix-open-issue once as a headless Claude Code session.
# Designed to be called from cron. Uses a lock plus PID file to enforce one local process.
# Uses its own lock/PID/log namespace.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
LOG_DIR="$REPO_DIR/.fix-open-issue-logs"
LOCK_FILE="$REPO_DIR/.fix-open-issue.lock"
PID_FILE="$REPO_DIR/.fix-open-issue.pid"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d_%H-%M-%S).log"

# Skip if already running
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  running_pid="unknown"
  if [ -s "$PID_FILE" ]; then
    running_pid="$(<"$PID_FILE")"
  fi
  echo "$(date): fix-open-issue already running (pid $running_pid), skipping." | tee -a "$LOG_DIR/skipped.log"
  exit 0
fi

printf '%s\n' "$$" > "$PID_FILE"
cleanup() {
  rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

echo "$(date): Starting fix-open-issue" | tee "$LOG_FILE"

# Load user environment (gh, node, npx, etc.)
# shellcheck disable=SC1091
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true

cd "$REPO_DIR"

claude --print "/fix-open-issue" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Task,TodoWrite" \
  2>&1 | tee -a "$LOG_FILE"

echo "$(date): fix-open-issue complete" | tee -a "$LOG_FILE"
