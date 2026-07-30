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

import collections
import json
import os
import random
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory

from traceact import (
    ActionTrace,
    AsyncSink,
    HttpSink,
    JsonlSink,
    OtlpSink,
    SqliteSink,
    TraceActMiddleware,
    TraceBudget,
    TraceConfig,
    TraceLog,
    configure,
    inject_headers,
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

TRACES_DIR  = os.path.join(os.path.dirname(__file__), "data", "traces")
TRACES_FILE = os.path.join(TRACES_DIR, "traces.jsonl")
TRACES_DB   = os.path.join(os.path.dirname(__file__), "data", "traces.db")

# Each sink points at an echo endpoint inside this same Flask app — no external
# collector required. OtlpSink appends /v1/traces to the base URL it receives.
http_sink   = HttpSink("http://127.0.0.1:5001/sink/http-receive", timeout=2.0)
otlp_sink   = OtlpSink(
    "http://127.0.0.1:5001/sink/otlp-receive",
    timeout=2.0,
    resource_attributes={"service.name": "traceact-demo", "deployment.env": "local"},
)
sqlite_sink = SqliteSink(TRACES_DB)
async_http  = AsyncSink([http_sink])
async_otlp  = AsyncSink([otlp_sink])

configure(
    project="traceact",
    config=TraceConfig(sink_mode="blocking"),
    sinks=[JsonlSink(TRACES_FILE), sqlite_sink, async_http, async_otlp],
)

# ---------------------------------------------------------------------------
# In-memory echo stores — last 20 deliveries per sink, newest first
# ---------------------------------------------------------------------------

_http_log: collections.deque = collections.deque(maxlen=20)
_otlp_log: collections.deque = collections.deque(maxlen=20)

# ---------------------------------------------------------------------------
# Flask app setup
# ---------------------------------------------------------------------------

# static_folder="static" tells Flask where to find index.html, app.js, styles.css.
# static_url_path="" means those files are served at the root, not /static/.
app = Flask(__name__, static_folder="static", static_url_path="")
app.wsgi_app = TraceActMiddleware(app.wsgi_app)


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
# Action: Sampled-out failure
# ---------------------------------------------------------------------------
#
# Demonstrates always_trace_errors under sampling. This action runs with a
# per-call budget of sample_rate=0.0 (every call is sampled out) and
# always_trace_errors=True. In a sampled-out trace nothing is recorded while
# the action runs — but because the action fails, TraceAct still writes a
# record after the fact: status="failed", the error, and sampled_out=true,
# with empty steps/events (there was no recording to capture them).
#
# The budget override is scoped to this one action; every other action in the
# demo keeps the default record-everything behaviour. Fire this a few times
# and watch the "sampled-out errors" counter on the Explore tab climb.

@app.route("/api/sampled-failure", methods=["POST"])
def sampled_failure():
    try:
        with ActionTrace.start(
            action="sampled.failure",
            kind="app",
            actor="user",
            budget=TraceBudget(sample_rate=0.0, always_trace_errors=True),
        ) as trace:
            # These calls are silent no-ops: the trace is sampled out, so
            # nothing is recorded until (and unless) the action fails.
            trace.step("Charging card — not recorded while sampled out")
            trace.event(kind="http", operation="post", target="payment.gateway")
            raise ValueError("Simulated failure under 100% sampling")
    except ValueError:
        # The promoted failure record was written on __exit__; swallow the
        # exception so the HTTP response stays clean, same as trigger-error.
        pass

    return jsonify({"ok": True, "message": "Sampled-out failure recorded"})


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
        trace.step("Checking rate limiter")
        time.sleep(0.004)

        trace.http(operation="post", target="rate-limiter.internal",
                   status_code=200, duration_ms=4.0)
        trace.step("Validating credentials")
        time.sleep(0.008)

        trace.event(kind="db", operation="select", target="users", rows=1)
        trace.step("Credentials verified — creating session token")
        time.sleep(0.004)

        session_token = f"sess_{uuid.uuid4().hex[:16]}"
        trace.event(kind="db", operation="insert", target="sessions", rows=1)
        trace.step("Recording audit event")
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
        trace.step("Filtering unsubscribes")
        time.sleep(0.005)

        trace.event(kind="db", operation="select", target="unsubscribes", rows=0)
        trace.step(f"Rendering template for {subscriber_count} subscribers")
        time.sleep(0.006)

        trace.event(kind="app", operation="compute", target="template-engine",
                    template="newsletter_v2")
        trace.step("Dispatching campaign via campaign service")
        trace.event(kind="email", operation="send", target="campaign-service",
                    recipient_count=subscriber_count, subject=subject)
        time.sleep(0.012)

        trace.step("Recording delivery log")
        trace.event(kind="db", operation="insert", target="delivery_log",
                    rows=subscriber_count)
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
        trace.http(operation="put", target="s3.reports-bucket",
                   status_code=200, duration_ms=12.0)
        trace.step("Report uploaded to storage")
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

        trace.event(kind="app", operation="compute", target="validator",
                    rows_validated=row_count)
        trace.step("Checking for duplicates")
        time.sleep(0.008)

        trace.event(kind="db", operation="select", target="dedup_index",
                    rows=row_count)
        trace.step("Batch inserting records into database")
        time.sleep(0.028)

        trace.event(kind="db", operation="insert", target="imports", rows=row_count)
        trace.step("Updating search index")
        trace.http(operation="post", target="search.indexer",
                   status_code=202, duration_ms=15.0)
        trace.step("Import complete")
        trace.output({"imported": row_count, "failed": 0})

    return jsonify({"ok": True, "imported": row_count})


# ---------------------------------------------------------------------------
# Action: Cross-service order (propagation demo)
# ---------------------------------------------------------------------------
#
# Two routes standing in for two separate services, wired together by a real
# HTTP call so TraceActMiddleware can propagate the trace context automatically.
#
# order.submit (order service) → inject_headers() → HTTP POST → payment.charge
# payment.charge (payment service) — middleware extracts headers, no manual code

@app.route("/api/order-submit", methods=["POST"])
def order_submit():
    order_id = f"ord_{uuid.uuid4().hex[:8]}"
    corr_id  = f"corr_{uuid.uuid4().hex[:8]}"

    with ActionTrace.start(
        action="order.submit", kind="app", actor="user",
        correlation_id=corr_id,
    ) as trace:
        trace.input({"order_id": order_id})
        trace.step("Validating order")
        time.sleep(0.008)

        trace.event(kind="db", operation="select", target="inventory",
                    rows=1)
        trace.step("Reserving inventory")
        time.sleep(0.006)

        trace.event(kind="db", operation="update", target="inventory",
                    rows=1)
        trace.step("Calling payment service")

        # inject_headers() stamps traceact-trace-id + traceact-correlation-id
        # onto the outbound request so the payment service can link back to us.
        prop_headers = inject_headers({"Content-Type": "application/json"})
        req = urllib.request.Request(
            "http://127.0.0.1:5001/api/payment-charge",
            data=json.dumps({"order_id": order_id, "amount": 49.99}).encode(),
            headers=prop_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                charge_result = json.loads(resp.read())
        except urllib.error.URLError as exc:
            charge_result = {"ok": False, "error": str(exc)}

        trace.http(operation="post", target="payment-service.internal",
                   status_code=200 if charge_result.get("ok") else 500,
                   duration_ms=18.0)
        trace.step("Payment confirmed — order complete")
        trace.output({"order_id": order_id, "charge": charge_result})

    return jsonify({"ok": True, "order_id": order_id, "charge_result": charge_result})


@app.route("/api/payment-charge", methods=["POST"])
def payment_charge():
    # TraceActMiddleware already extracted the propagation headers before this
    # route runs — no manual propagation code needed here.
    data       = request.get_json() or {}
    order_id   = data.get("order_id", "unknown")
    amount     = data.get("amount", 0)
    charge_id  = f"chg_{uuid.uuid4().hex[:8]}"

    with ActionTrace.start(action="payment.charge", kind="app") as trace:
        trace.input({"order_id": order_id, "amount": amount})
        trace.step("Validating card on file")
        time.sleep(0.005)

        trace.event(kind="db", operation="select", target="payment_methods", rows=1)
        trace.step("Charging via payment gateway")
        time.sleep(0.014)

        trace.http(operation="post", target="payment.gateway",
                   status_code=200, duration_ms=14.0)
        trace.step("Charge authorised")
        trace.output({"charge_id": charge_id, "amount": amount, "status": "authorised"})

    return jsonify({"ok": True, "charge_id": charge_id, "amount": amount})


# ---------------------------------------------------------------------------
# Agent turn — tool-call tracking (kind="tool") and explicit parenting
# ---------------------------------------------------------------------------
#
# Simulates one agent turn the way an adapter records it: a root agent.run
# trace, a child model call, and two child tool calls — one of which fails.
# The children are created with an explicit parent (ActionTrace.start(
# parent=...)) rather than nesting, the same mechanism the LangChain adapter
# uses when callbacks arrive on unrelated stacks. Select the agent.run trace
# and open the map to watch the turn replay.

@app.route("/api/agent-run", methods=["POST"])
def agent_run():
    data  = request.get_json() or {}
    query = data.get("query", "What did we ship last week?")

    root = ActionTrace.start(action="agent.run", kind="app", actor="agent")
    root.step("Planning the turn")

    # The model decides which tools to call.
    model = ActionTrace.start(action="model.claude-sonnet-5", kind="model",
                              actor="agent", parent=root)
    time.sleep(0.012)
    model.model(operation="completion", target="claude-sonnet-5",
                tokens_in=830, tokens_out=112)
    model.__exit__(None, None, None)
    root.step("Model chose: web_search, python_repl")

    # Tool 1 succeeds.
    search = ActionTrace.start(action="tool.web_search", kind="tool",
                               actor="agent", parent=root)
    time.sleep(0.008)
    search.tool(operation="call", target="web_search",
                result={"results": 3}, duration_ms=8.0)
    search.__exit__(None, None, None)

    # Tool 2 fails BY DESIGN — the demo's point is watching a failed tool
    # roll up into the agent's trace. The message says so, loudly, so the
    # error can't be mistaken for a bug in the demo itself.
    repl = ActionTrace.start(action="tool.python_repl", kind="tool",
                             actor="agent", parent=root)
    time.sleep(0.004)
    err = RuntimeError(
        "scripted demo failure: the python_repl tool raised "
        "NameError: name 'df' is not defined")
    repl.tool(operation="execute", target="python_repl",
              status="failed", error={"type": "RuntimeError",
                                      "message": str(err)})
    repl.__exit__(type(err), err, None)

    root.step("Composed answer from 3 search results")
    root.__exit__(None, None, None)

    return jsonify({"ok": True, "query": query, "tools_called": 2,
                    "tools_failed": 1})


# ---------------------------------------------------------------------------
# Secret leak attempt — value-pattern redaction
# ---------------------------------------------------------------------------
#
# An app loads a deployment config that happens to contain credential-shaped
# values under innocent field names — the exact case field-name redaction
# cannot catch. The route just does its work and records it; the redaction
# happens inside the library at capture time. Proof lives in the record:
# inputs hold "[redacted:aws-key]" / "[redacted:sk-token]" (prose intact),
# and the file-read event's result is scrubbed the same way. The credentials
# below are fake, and never reach the JSONL file either way.

@app.route("/api/leak-attempt", methods=["POST"])
def leak_attempt():
    fake_aws = "AKIA" + "IOSFODNN7EXAMPLE"
    fake_sk  = "sk-" + "proj4bcd5fgh6jkl7nopq8st"

    with ActionTrace.start(action="config.load", kind="app",
                           actor="user") as trace:
        trace.step("Reading deployment config")
        time.sleep(0.004)
        config = {
            "region": "eu-west-1",
            "location": fake_aws,  # a key hiding in an innocent field name
            "note": f"deploy to staging with {fake_sk} before Friday",
        }
        trace.input(config)
        trace.file(operation="read", target="deploy.env",
                   result={"raw": f"AWS_ACCESS_KEY={fake_aws}"})
        trace.step("Config loaded")

    return jsonify({"ok": True,
                    "hint": "open the trace: inputs and the file event's "
                            "result hold [redacted:…] placeholders"})


# ---------------------------------------------------------------------------
# Card update — capture transforms (hash / last4)
# ---------------------------------------------------------------------------
#
# @traced_action captures arguments through per-field transforms: the user ID
# is stored as a deterministic hash (same user, same hash, every run — try it
# twice), the card number keeps only its tail, and the raw values never reach
# the record. "card_number" would normally be name-redacted to "[redacted]";
# the explicit transform is the handling instruction, so "…4242" survives.

@traced_action(
    action="card.update",
    kind="app",
    actor="user",
    capture_inputs=["user_id:hash", "card_number:last4", "amount"],
)
def _update_card(user_id, card_number, amount):
    time.sleep(0.006)
    return {"updated": True}


@app.route("/api/card-update", methods=["POST"])
def card_update():
    data = request.get_json() or {}
    _update_card(
        user_id=data.get("user_id", "user_12345"),
        card_number=data.get("card_number", "4242424242424242"),
        amount=data.get("amount", 49.99),
    )
    return jsonify({"ok": True,
                    "hint": "inputs show sha256:… and …4242, never the raw values"})


# ---------------------------------------------------------------------------
# Sink echo endpoints — receive deliveries from HttpSink / OtlpSink
# ---------------------------------------------------------------------------

@app.route("/sink/http-receive", methods=["POST"])
def sink_http_receive():
    _http_log.appendleft({
        "received_at": datetime.utcnow().isoformat() + "Z",
        "payload": request.get_json(force=True, silent=True) or {},
    })
    return "", 200


# OtlpSink posts to {endpoint}/v1/traces — the route must include that suffix.
@app.route("/sink/otlp-receive/v1/traces", methods=["POST"])
def sink_otlp_receive():
    body = request.get_json(force=True, silent=True) or {}
    try:
        span = body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    except (KeyError, IndexError):
        span = {}
    _otlp_log.appendleft({
        "received_at": datetime.utcnow().isoformat() + "Z",
        "span_name":   span.get("name", "—"),
        "trace_id":    span.get("traceId", "—"),
        "status":      span.get("status", {}),
        "attributes":  span.get("attributes", []),
        "events":      span.get("events", []),
        "full_payload": body,
    })
    return "", 200


# ---------------------------------------------------------------------------
# Sink log APIs — read back what was delivered
# ---------------------------------------------------------------------------

@app.route("/api/sink/http-log")
def api_sink_http_log():
    return jsonify(list(_http_log))


@app.route("/api/sink/otlp-log")
def api_sink_otlp_log():
    return jsonify(list(_otlp_log))


@app.route("/api/sink-stats")
def api_sink_stats():
    jsonl_kb = round(os.path.getsize(TRACES_FILE) / 1024, 1) if os.path.exists(TRACES_FILE) else 0
    try:
        import sqlite3
        conn = sqlite3.connect(TRACES_DB)
        sqlite_rows = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
        conn.close()
    except Exception:
        sqlite_rows = 0
    # Count error-only records promoted from sampled-out traces (see the
    # sampled-failure action). filter(sampled_out=True) skips every normal
    # record — including older ones written before the field existed, since a
    # missing field never matches an exact filter.
    try:
        sampled_out = TraceLog(TRACES_FILE).filter(sampled_out=True).count()
    except Exception:
        sampled_out = 0
    return jsonify({
        "jsonl":  {"size_kb": jsonl_kb},
        "sqlite": {"rows": sqlite_rows},
        "http":   {"received": len(_http_log), "failed": http_sink.failed},
        "otlp":   {"received": len(_otlp_log), "failed": otlp_sink.failed},
        "async":  {"http_dropped": async_http.dropped, "otlp_dropped": async_otlp.dropped},
        "sampled_out": {"count": sampled_out},
    })


# ---------------------------------------------------------------------------
# TraceLog query API
# ---------------------------------------------------------------------------

@app.route("/api/tracelog/query", methods=["POST"])
def api_tracelog_query():
    body    = request.get_json() or {}
    filters = body.get("filters", {})
    limit   = int(body.get("limit", 20))
    log     = TraceLog(TRACES_FILE)
    for key, value in filters.items():
        if value:
            log = log.filter(**{key: value})
    return jsonify(log.last(limit))


@app.route("/api/tracelog/view", methods=["POST"])
def api_tracelog_view():
    body    = request.get_json() or {}
    filters = body.get("filters", {})
    log     = TraceLog(TRACES_FILE)
    for key, value in filters.items():
        if value:
            log = log.filter(**{key: value})
    return jsonify({"url": log.view(open_browser=False)})


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
    if os.path.exists(TRACES_DB):
        os.remove(TRACES_DB)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # debug=True enables auto-reload on code changes, which is useful when
    # exploring the demo. Port 5001 avoids clashing with macOS AirPlay (5000).
    app.run(debug=True, port=5001)
