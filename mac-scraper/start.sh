#!/bin/bash
# ── Toronto Ticket Tracker — Mac Scraper Start Script ────────────────────────
# Run this once from Terminal: bash mac-scraper/start.sh
# Keep the Terminal window open while the scraper runs.

set -e  # exit on first error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║   Toronto Ticket Tracker — Mac Scraper ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found."
  echo "    Download and install it from: https://nodejs.org (choose LTS version)"
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.version.replace('v','').split('.')[0])")
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌  Node.js v20 or higher is required (you have v$NODE_VERSION)."
  echo "    Download the latest LTS from: https://nodejs.org"
  exit 1
fi
echo "✓  Node.js $(node --version)"

# ── Check Chrome ──────────────────────────────────────────────────────────────
if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "✓  Google Chrome found"
else
  echo "⚠️  Google Chrome not found at /Applications/Google Chrome.app"
  echo "   Download it from https://www.google.com/chrome/ and install before running."
  echo "   The scraper needs Chrome to visit ticketing websites."
  exit 1
fi

# ── Check .env ────────────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo ""
  echo "⚠️  No .env file found. Creating one from the example..."
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "   → Edit mac-scraper/.env and add your GITHUB_TOKEN, then re-run this script."
  echo ""
  echo "   How to get a GitHub Token:"
  echo "   1. Go to github.com → Settings → Developer settings"
  echo "   2. Personal access tokens → Tokens (classic)"
  echo "   3. Generate new token → tick 'repo' → copy it"
  echo "   4. Paste it into mac-scraper/.env"
  exit 1
fi

# Check if token is still the placeholder
if grep -q "your_github_personal_access_token_here" "$SCRIPT_DIR/.env"; then
  echo ""
  echo "⚠️  GITHUB_TOKEN in .env is still the placeholder value."
  echo "   Open mac-scraper/.env and replace it with your real token."
  exit 1
fi

echo "✓  .env loaded"

# ── Install dependencies ──────────────────────────────────────────────────────
echo ""
echo "Installing mac-scraper dependencies..."
cd "$SCRIPT_DIR" && npm install --silent

echo "Installing backend scraper dependencies..."
cd "$REPO_ROOT/backend" && npm install --silent

cd "$REPO_ROOT"
echo "✓  All dependencies installed"

# ── Launch (caffeinate keeps Mac awake while running) ─────────────────────────
echo ""
echo "Starting scraper... (Mac will stay awake while this runs)"
echo "Press Ctrl+C to stop."
echo ""

caffeinate -i node mac-scraper/scraper-runner.js
