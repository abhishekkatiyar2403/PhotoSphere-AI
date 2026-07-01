#!/usr/bin/env bash
# Headless Tester Agent run, meant to be fired by cron/launchd at 06:00 and 18:00.
# Requires: Claude Code CLI installed and authenticated (`claude`), dev server already running.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

TIMESTAMP="$(date +%Y-%m-%d_%H%M)"
echo "[$TIMESTAMP] Starting scheduled Tester Agent run..."

# --dangerously-skip-permissions runs fully unattended (no interactive approval prompts).
# Only safe because the tester agent's tool access (Read, Write, Bash, Glob, Grep) is scoped
# in .claude/agents/tester.md and it never touches app code. Review that scope before relying
# on this in CI or on a shared machine.
claude -p "/run-tester" --dangerously-skip-permissions

echo "[$TIMESTAMP] Tester run complete. Triggering developer run..."
"$PROJECT_DIR/scripts/run-developer-cron.sh"
