# TraceAct Demo

A Flask-based demo app for [TraceAct](https://github.com/traceact/traceact) — fire actions, watch traces appear in real time, and explore what gets recorded across four live sinks.

## Features

- 10 fireable actions covering auth, messaging, email campaigns, report export, webhook dispatch, and bulk import
- **Traces tab**: tabular view of every trace with status, duration, steps, events, and errors
- **Map tab**: inline SVG trace visualizer showing actor → action → touched resources with colour-coded bezier connections
- **Explore tab**: live sink stats (JSONL, SQLite, HTTP, OTLP) plus a TraceLog query builder with Python snippet preview
- Trace Inspector: right-hand panel with per-trace breakdown (steps, events, touches, errors) and "View map →" shortcut
- Four parallel sinks: `JsonlSink`, `SqliteSink`, `AsyncSink(HttpSink)`, `AsyncSink(OtlpSink)` — all pointing at local echo endpoints
- Live action search and drag-to-resize columns

## Getting started

Double-click `launch.command` (macOS) or `launch.sh` (Linux) — it creates a virtual environment, installs dependencies, starts the server, and opens the browser automatically.

Or manually:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e ../traceact
python app.py
```

Then open [http://localhost:5001](http://localhost:5001).

## Traces

Traces are written to `data/traces/traces.jsonl` (gitignored). Use "Clear traces" in the UI to reset, or delete the file manually.

---

Built by [Mo Shehu](https://mohammedshehu.com).
