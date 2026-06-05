#!/usr/bin/env bash
# Installs the VIDF commit-msg hook into the current git repository.
# Usage: bash scripts/vidf-hook/install-git-hook.sh [pm-app-url]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)

if [ -z "$GIT_DIR" ]; then
  echo "Error: not in a git repository." >&2
  exit 1
fi

HOOKS_DIR="${GIT_DIR}/hooks"
HOOK_FILE="${HOOKS_DIR}/commit-msg"

mkdir -p "$HOOKS_DIR"
cp "${SCRIPT_DIR}/commit-msg" "$HOOK_FILE"
chmod +x "$HOOK_FILE"

# Optionally set the PM App URL
if [ -n "$1" ]; then
  git config viscap.pmAppUrl "$1"
  echo "PM App URL set to: $1"
fi

echo "✓ VIDF commit-msg hook installed at ${HOOK_FILE}"
echo ""
echo "Every commit will be tagged: [vidf:v1 | bundle:v{N} | sprint:{YYYY-MM}]"
echo "The hook exits silently if the PM App is unreachable — it will never block a commit."
echo ""
echo "To set the PM App URL later:"
echo "  git config viscap.pmAppUrl https://pm.viscapmedia.com"
