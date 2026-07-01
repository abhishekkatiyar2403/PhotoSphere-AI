#!/usr/bin/env bash
# Headless Developer Agent run — normally chained after run-tester-cron.sh, but can run standalone.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

TIMESTAMP="$(date +%Y-%m-%d_%H%M)"
echo "[$TIMESTAMP] Starting scheduled Developer Agent run..."

claude -p "/run-developer" --dangerously-skip-permissions

echo "[$TIMESTAMP] Developer run complete."
