@echo off
REM launch.bat — Windows double-click launcher for TraceAct Demo

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo =^> TraceAct Demo launcher
echo    Working directory: %~dp0
echo.

REM ── 1. Python check ─────────────────────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo ERROR: python not found. Install Python 3.10+ from https://python.org and try again.
    pause
    exit /b 1
  )
  set PYTHON=py
) else (
  set PYTHON=python
)

for /f "tokens=*" %%v in ('!PYTHON! --version') do echo =^> %%v

REM ── 2. Virtual environment ───────────────────────────────────────────────────
if not exist ".venv\" (
  echo =^> Creating virtual environment at .venv ...
  !PYTHON! -m venv .venv
)
call .venv\Scripts\activate.bat
echo =^> Activated .venv

REM ── 3. Dependencies ──────────────────────────────────────────────────────────
echo =^> Checking dependencies ...
REM traceact comes from PyPI; GitHub is the fallback for when the required
REM version isn't released yet. NEVER install it from a local folder.
pip install --quiet -r requirements.txt
if errorlevel 1 (
  echo =^> Required traceact not on PyPI yet — falling back to GitHub ...
  pip install --quiet "flask>=3.0"
  pip install --quiet "traceact @ git+https://github.com/traceact/traceact"
  if errorlevel 1 (
    echo ERROR: could not install traceact from PyPI or GitHub.
    pause
    exit /b 1
  )
)
echo =^> Dependencies OK

REM ── 4. Start Flask server ────────────────────────────────────────────────────
set PORT=5001
echo.
echo =^> Starting Flask app on http://localhost:!PORT!
echo    (Close this window to stop the server)
echo.

REM Open browser after a short delay (server needs a moment to start).
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:!PORT!"

REM Run Flask in the foreground so the window stays open.
python app.py

pause
