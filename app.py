# app.py
#
# TraceAct Demo — Flask backend
#
# This app demonstrates TraceAct by exposing six actions, each of which
# produces a trace written to data/traces/traces.jsonl in real time.
# A trace viewer API reads that file and serves the records to the frontend.
#
# Six actions:
#   POST /api/create-note    — records a note; simulates a DB insert
#   POST /api/generate-number — picks a random number; lightweight compute trace
#   POST /api/save-message   — DB write + fake notification event
#   POST /api/fake-api-call  — simulated outbound HTTP GET via trace.http()
#   POST /api/trigger-error  — raises a real exception; trace shows status=failed
#   POST /api/traces/clear   — deletes the JSONL file; resets the viewer
#
# Trace viewer API:
#   GET  /api/traces          — returns all trace records as a JSON array
#   POST /api/traces/clear    — deletes the JSONL file
#
# To run:
#   pip install -r requirements.txt
#   pip install -e ../traceact
#   python app.py
#
# Then open http://localhost:5001 in your browser.

import json
import os
import random
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory

from traceact import (
    ActionTrace,
    JsonlSink,
    TraceConfig,
    configure,
    traced_action,
)

# ---------------------------------------------------------------------------
# TraceAct configuration
# ---------------------------------------------------------------------------
#
# Configure once at startup. sink_mode="blocking" means each trace is written
# to disk immediately when the action finishes — no buffering, no flush needed.
# This makes traces appear in the viewer as soon as the HTTP response returns.
#
# The JSONL file lives at data/traces/traces.jsonl relative to this file.
# JsonlSink creates the parent directories automatically.

TRACES_DIR = os.path.join(os.path.dirname(__file__), "data", "traces")
TRACES_FILE = os.path.join(TRACES_DIR, "traces.jsonl")

configure(
    config=TraceConfig(sink_mode="blocking"),
    sinks=[JsonlSink(TRACES_FILE)],
)

# ---------------------------------------------------------------------------
# Flask app setup
# ---------------------------------------------------------------------------

# static_folder="static" tells Flask where to find index.html, app.js, styles.css.
# static_url_path="" means those files are served at the root, not /static/.
app = Flask(__name__, static_folder="static", static_url_path="")


@app.route("/")
def index():
    """Serve the single-page trace viewer UI."""
    return send_from_directory("static", "index.html")


# ---------------------------------------------------------------------------
# Action: Create note
# ---------------------------------------------------------------------------
#
# Simulates a note creation: validate the title and body, run a fake DB
# insert, and return a generated note ID.
#
# Trace anatomy:
#   - Two trace.step() calls mark the major phases of the action.
#   - One trace.event(kind="db", ...) records the simulated insert.
#   - trace.input() and trace.output() bookend the action's data flow.

@app.route("/api/create-note", methods=["POST"])
def create_note():
    data = request.get_json() or {}
    title = data.get("title", "Untitled")
    body = data.get("body", "")

    # Open a manual trace so we can call trace.step() and trace.event()
    # inside the function body. The with-block auto-finishes the trace on exit.
    with ActionTrace.start(action="note.create", kind="app", actor="user") as trace:
        # Record what arrived at the action's boundary.
        trace.input({"title": title, "body": body})

        trace.step("Validated input fields")

        # Simulate a short DB round-trip.
        time.sleep(0.012)

        # Generate a fake note ID — in a real app this would come from the DB.
        note_id = f"note_{uuid.uuid4().hex[:8]}"

        # Record the DB insert as a structured event. TraceAct automatically
        # derives a touch from this: {kind: "db_table", target: "notes"}.
        trace.event(kind="db", operation="insert", target="notes", rows=1)

        trace.step("Note saved to database")

        # Record what the action produced.
        trace.output({"note_id": note_id, "created": True})

    return jsonify({"ok": True, "note_id": note_id})


# ---------------------------------------------------------------------------
# Action: Generate number
# ---------------------------------------------------------------------------
#
# A lightweight trace — picks a random integer and records a single compute
# event. Useful for showing that simple actions produce small, clean records.

@app.route("/api/generate-number", methods=["POST"])
def generate_number():
    with ActionTrace.start(action="number.generate", kind="app") as trace:
        trace.step("Seeding random number generator")

        number = random.randint(1, 10_000)

        # The compute event records what the action actually did and what it
        # produced. The result field is stored on the event (and sanitised
        # if it exceeds the payload size limit).
        trace.event(kind="app", operation="compute", target="rng", result=number)

        trace.step("Number generated")
        trace.output({"number": number})

    return jsonify({"ok": True, "number": number})


# ---------------------------------------------------------------------------
# Action: Save message
# ---------------------------------------------------------------------------
#
# Simulates two things happening inside one action: a DB write, then a fake
# notification event via a hypothetical email service. This shows how a single
# trace can span multiple event kinds ("db" and "email") and produces two
# separate touches in the touch list.

@app.route("/api/save-message", methods=["POST"])
def save_message():
    data = request.get_json() or {}
    message = data.get("message", "Hello")

    with ActionTrace.start(action="message.save", kind="app", actor="user") as trace:
        trace.input({"message": message})

        trace.step("Writing message to database")

        time.sleep(0.010)
        message_id = f"msg_{uuid.uuid4().hex[:8]}"

        # DB insert event — creates a touch on the "messages" table.
        trace.event(kind="db", operation="insert", target="messages", rows=1)

        trace.step("Dispatching notification event")

        # Notification event — creates a touch on "notification-service".
        # This is purely simulated; no real email is sent.
        trace.event(
            kind="email",
            operation="send",
            target="notification-service",
            recipient="user@example.com",
        )

        trace.step("Message saved and notification dispatched")
        trace.output({"message_id": message_id, "notified": True})

    return jsonify({"ok": True, "message_id": message_id})


# ---------------------------------------------------------------------------
# Action: Fake API call
# ---------------------------------------------------------------------------
#
# Simulates an outbound HTTP GET with no real network traffic. Uses the
# trace.http() convenience helper (a thin wrapper around trace.event(kind="http"))
# to record the request. This shows how TraceAct captures external calls.

@app.route("/api/fake-api-call", methods=["POST"])
def fake_api_call():
    with ActionTrace.start(action="api.fetch", kind="http") as trace:
        trace.step("Preparing outbound request to api.example.com")

        # Simulate network latency — a real HTTP call would take 20–200 ms.
        time.sleep(0.035)

        # trace.http() records kind="http", operation="get", target="api.example.com".
        # TraceAct derives a touch: {kind: "http_endpoint", target: "api.example.com"}.
        trace.http(
            operation="get",
            target="api.example.com",
            status_code=200,
            duration_ms=35.0,
        )

        trace.step("Response received and parsed")
        trace.output({"status_code": 200, "body": {"data": "example response payload"}})

    return jsonify({"ok": True, "status_code": 200})


# ---------------------------------------------------------------------------
# Action: Trigger error
# ---------------------------------------------------------------------------
#
# Uses @traced_action on a helper function that always raises. When the
# decorated function raises, the decorator catches the exception, calls
# trace._finish(status="failed", error=exc) to record it, then re-raises.
#
# The Flask route catches the re-raised exception so the HTTP response is
# still 200 — the trace record is what shows the failure.

@traced_action(action="error.trigger", kind="app", actor="user")
def _do_trigger_error():
    """
    This function always raises. @traced_action records the exception in
    the trace (status='failed', errors=[...]) before re-raising it.
    """
    # Add a small sleep so the trace has a non-zero duration — makes the
    # demo table easier to read.
    time.sleep(0.005)
    raise ValueError("Simulated failure: database connection refused at 127.0.0.1:5432")


@app.route("/api/trigger-error", methods=["POST"])
def trigger_error():
    try:
        _do_trigger_error()
    except ValueError:
        # The trace has already been written before we get here — the decorator
        # calls _finish() inside its except block, then re-raises. We swallow
        # the exception so the HTTP response stays clean.
        pass

    return jsonify({"ok": True, "message": "Error triggered and recorded in trace"})


# ---------------------------------------------------------------------------
# Action: User login
# ---------------------------------------------------------------------------
#
# Simulates a credential check: select from users table, create a session,
# then write an audit-log entry. Two DB events → two touches.

@app.route("/api/auth-login", methods=["POST"])
def auth_login():
    data = request.get_json() or {}
    username = data.get("username", "alice")

    with ActionTrace.start(action="auth.login", kind="app", actor="user") as trace:
        trace.input({"username": username})
        trace.step("Validating credentials")
        time.sleep(0.008)

        trace.event(kind="db", operation="select", target="users", rows=1)
        trace.step("Credentials verified — creating session token")
        time.sleep(0.004)

        session_token = f"sess_{uuid.uuid4().hex[:16]}"
        trace.event(kind="db", operation="insert", target="audit_log", rows=1)
        trace.step("Session created and audit event recorded")
        trace.output({"session_token": session_token, "authenticated": True})

    return jsonify({"ok": True, "session_token": session_token})


# ---------------------------------------------------------------------------
# Action: Email campaign
# ---------------------------------------------------------------------------
#
# Loads subscribers from the DB, then dispatches a bulk campaign through a
# hypothetical campaign service. Shows db + email events in one trace.

@app.route("/api/email-campaign", methods=["POST"])
def email_campaign():
    data = request.get_json() or {}
    subject = data.get("subject", "Monthly Newsletter")

    with ActionTrace.start(action="email.campaign", kind="app", actor="user") as trace:
        trace.input({"subject": subject})
        trace.step("Loading subscriber list from database")
        time.sleep(0.010)

        subscriber_count = random.randint(50, 200)
        trace.event(kind="db", operation="select", target="subscribers",
                    rows=subscriber_count)
        trace.step(f"Rendering template for {subscriber_count} subscribers")
        time.sleep(0.006)

        trace.step("Dispatching campaign via campaign service")
        trace.event(kind="email", operation="send", target="campaign-service",
                    recipient_count=subscriber_count, subject=subject)
        time.sleep(0.012)

        trace.output({"sent": subscriber_count, "subject": subject})

    return jsonify({"ok": True, "sent": subscriber_count})


# ---------------------------------------------------------------------------
# Action: Export report
# ---------------------------------------------------------------------------
#
# Queries a large event table, runs a compute-heavy aggregation, then
# serialises results as CSV. Shows db + compute (rng node) in one trace.

@app.route("/api/report-export", methods=["POST"])
def report_export():
    with ActionTrace.start(action="report.export", kind="app", actor="user") as trace:
        trace.step("Querying events table for report window")
        time.sleep(0.018)

        row_count = random.randint(500, 5_000)
        trace.event(kind="db", operation="select", target="events", rows=row_count)
        trace.step(f"Aggregating {row_count} rows")
        time.sleep(0.022)

        trace.event(kind="app", operation="compute", target="rng",
                    rows_processed=row_count)
        trace.step("Serialising report to CSV")
        time.sleep(0.005)

        size_kb = round(row_count * 0.38, 1)
        trace.output({"format": "csv", "rows": row_count, "size_kb": size_kb})

    return jsonify({"ok": True, "rows": row_count, "size_kb": size_kb})


# ---------------------------------------------------------------------------
# Action: Dispatch webhook
# ---------------------------------------------------------------------------
#
# Signs a payload with HMAC-SHA256 and POSTs it to an external endpoint.
# No user actor — shows the Flask App → External API path without User node.

@app.route("/api/webhook-dispatch", methods=["POST"])
def webhook_dispatch():
    with ActionTrace.start(action="webhook.dispatch", kind="http") as trace:
        trace.step("Signing payload with HMAC-SHA256")
        time.sleep(0.003)

        trace.step("POSTing to webhook endpoint")
        time.sleep(0.038)

        trace.http(operation="post", target="hooks.customer.io",
                   status_code=200, duration_ms=38.0)
        trace.step("Delivery confirmed — response 200 OK")
        trace.output({"delivered": True, "status_code": 200})

    return jsonify({"ok": True, "delivered": True})


# ---------------------------------------------------------------------------
# Action: Bulk import
# ---------------------------------------------------------------------------
#
# Parses and validates incoming rows (compute event), then batch-inserts
# them into the imports table (db event). Row count is user-controlled.

@app.route("/api/import-bulk", methods=["POST"])
def import_bulk():
    data = request.get_json() or {}
    row_count = max(1, min(int(data.get("rows", 100)), 1_000))

    with ActionTrace.start(action="import.bulk", kind="app", actor="user") as trace:
        trace.input({"rows": row_count})
        trace.step(f"Parsing and validating {row_count} incoming records")
        time.sleep(0.014)

        trace.event(kind="app", operation="compute", target="rng",
                    rows_validated=row_count)
        trace.step("Batch inserting records into database")
        time.sleep(0.028)

        trace.event(kind="db", operation="insert", target="imports", rows=row_count)
        trace.step("Import complete — search index updated")
        trace.output({"imported": row_count, "failed": 0})

    return jsonify({"ok": True, "imported": row_count})


# ---------------------------------------------------------------------------
# Trace viewer: read all traces
# ---------------------------------------------------------------------------
#
# Reads traces.jsonl line by line, parses each line as a JSON object, and
# returns the list in reverse-chronological order (newest first) so the
# most recent action appears at the top of the viewer table.
#
# The endpoint returns an empty list if the file does not exist yet.

@app.route("/api/traces", methods=["GET"])
def get_traces():
    if not os.path.exists(TRACES_FILE):
        return jsonify([])

    records = []
    with open(TRACES_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                # Skip any malformed lines. Should never happen in practice
                # because JsonlSink writes complete JSON before the newline.
                continue

    # Reverse so the newest trace appears first in the table.
    records.reverse()
    return jsonify(records)


# ---------------------------------------------------------------------------
# Trace viewer: clear all traces
# ---------------------------------------------------------------------------
#
# Deletes the JSONL file so the viewer shows an empty state. JsonlSink will
# recreate the file automatically on the next traced action.

@app.route("/api/traces/clear", methods=["POST"])
def clear_traces():
    if os.path.exists(TRACES_FILE):
        os.remove(TRACES_FILE)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # debug=True enables auto-reload on code changes, which is useful when
    # exploring the demo. Port 5001 avoids clashing with macOS AirPlay (5000).
    app.run(debug=True, port=5001)
