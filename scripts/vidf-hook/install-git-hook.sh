#!/usr/bin/env bash
# VIDF Git Hook Installer
# Installs the prepare-commit-msg hook globally for all git repos on this machine.
# Run once per developer machine: bash scripts/vidf-hook/install-git-hook.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$HOME/.config/git/hooks"

echo "Installing VIDF git hook globally..."
echo ""

# Create global hooks directory
mkdir -p "$HOOKS_DIR"

# Configure git to use the global hooks directory
git config --global core.hooksPath "$HOOKS_DIR"

# Copy and make executable
cp "$SCRIPT_DIR/prepare-commit-msg" "$HOOKS_DIR/prepare-commit-msg"
chmod +x "$HOOKS_DIR/prepare-commit-msg"

echo "✓ Hook installed to $HOOKS_DIR/prepare-commit-msg"
echo "✓ Git configured to use global hooks (core.hooksPath)"
echo ""
echo "Now add these to your ~/.zshrc (or ~/.bashrc) and reload your shell:"
echo ""
echo "  export VIDF_PMAPP_URL=https://your-pm-app.vercel.app"
echo "  export VIDF_API_KEY=<get-from-pm-dashboard>"
echo ""
echo "To verify: make a test commit in any Viscap repo and check the message includes [vidf:...]"
echo ""

# Check if env vars are already set
if [ -z "$VIDF_PMAPP_URL" ] || [ -z "$VIDF_API_KEY" ]; then
  echo "⚠️  VIDF_PMAPP_URL or VIDF_API_KEY not currently set in this shell."
  echo "   The hook will use a default tag until you set them."
fi
