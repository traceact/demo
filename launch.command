#!/usr/bin/env bash
# launch.command — macOS double-click launcher for TraceAct Demo
# Works when double-clicked in Finder (Terminal opens automatically).

set -euo pipefail

# cd to the directory this script lives in, regardless of where Terminal cwd is.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> TraceAct Demo launcher"
echo "    Working directory: $SCRIPT_DIR"
echo ""

# ── 1. Python 3 check ────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3.10+ from https://python.org and try again."
  read -r -p "Press Enter to close..."
  exit 1
fi
PYTHON=$(command -v python3)
echo "==> Python: $($PYTHON --version)"

# ── 2. Virtual environment ────────────────────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "==> Creating virtual environment at .venv ..."
  "$PYTHON" -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
echo "==> Activated .venv"

# ── 3. Dependencies ───────────────────────────────────────────────────────────
echo "==> Checking dependencies ..."
# traceact comes from PyPI; GitHub is the fallback for when the required
# version isn't released yet. NEVER install it from a local folder — a fork
# of this demo must run anywhere on the published package alone.
if ! pip install --quiet -r requirements.txt; then
  echo "==> Required traceact not on PyPI yet — falling back to GitHub ..."
  pip install --quiet "flask>=3.0"
  if ! pip install --quiet "traceact @ git+https://github.com/traceact/traceact"; then
    echo "ERROR: could not install traceact from PyPI or GitHub."
    exit 1
  fi
fi
echo "==> Dependencies OK"

# ── 4. Start Flask server ─────────────────────────────────────────────────────
PORT=5001
echo ""
echo "==> Starting Flask app on http://localhost:$PORT"
echo "    (Press Ctrl-C in this window to stop)"
echo ""

# Launch server in background, wait until it responds, then open browser.
python app.py &
SERVER_PID=$!

# Poll until the port is accepting connections (max 10 s).
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT" &>/dev/null; then
    break
  fi
  sleep 0.5
done

echo "==> Opening browser ..."
open "http://localhost:$PORT"

# Bring the Flask process to the foreground so Ctrl-C stops it cleanly.
wait $SERVER_PID
