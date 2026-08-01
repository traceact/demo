#!/usr/bin/env bash
# launch.sh — Unix/Linux terminal launcher for TraceAct Demo
# Run: bash launch.sh  (or ./launch.sh after chmod +x)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> TraceAct Demo launcher"
echo "    Working directory: $SCRIPT_DIR"
echo ""

# ── 1. Python 3 check ────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3.10+ and try again."
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

# ── 4. Detect browser-open command ───────────────────────────────────────────
if command -v xdg-open &>/dev/null; then
  OPEN_CMD="xdg-open"
elif command -v open &>/dev/null; then
  OPEN_CMD="open"
else
  OPEN_CMD=""
fi

# ── 5. Start Flask server ─────────────────────────────────────────────────────
PORT=5001
echo ""
echo "==> Starting Flask app on http://localhost:$PORT"
echo "    (Press Ctrl-C to stop)"
echo ""

python app.py &
SERVER_PID=$!

for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT" &>/dev/null; then
    break
  fi
  sleep 0.5
done

if [ -n "$OPEN_CMD" ]; then
  echo "==> Opening browser ..."
  $OPEN_CMD "http://localhost:$PORT"
else
  echo "==> Open http://localhost:$PORT in your browser."
fi

wait $SERVER_PID
