// app.js — TraceAct Demo frontend
//
// Two views:
//   TraceLog — scrollable table of all trace records (original view)
//   TraceMap — SVG graph that lights up nodes/edges when a trace fires
//
// Core data flow:
//   1. User clicks "Run" → fire() POSTs to a Flask route
//   2. After AUTO_REFRESH_DELAY_MS, loadTraces() fetches /api/traces
//   3. renderTable() rebuilds the TraceLog table
//   4. selectTrace() sets selectedTrace and, if on TraceMap tab,
//      calls animateTrace() + renderTraceDetails()
//
// TraceMap graph topology (fixed nodes, driven by trace data):
//   [User] ──► [Flask App] ──► [Database]
//                  │         └─► [Email Service]
//                  │         └─► [External API]
//                  └─────────└─► [RNG / Compute]
//
// Which nodes/edges light up is determined by inspecting the trace's
// events list — kind="db" → Database node, kind="email" → Email Service, etc.

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------

const AUTO_REFRESH_DELAY_MS = 300;

// All SVG node IDs in the graph, in animation order (left → right)
const ALL_NODES = ['user', 'app', 'db', 'email', 'http', 'rng'];
const ALL_EDGES = ['user-app', 'app-db', 'app-email', 'app-http', 'app-rng'];

// The trace currently shown in TraceMap and highlighted in TraceLog
let selectedTrace = null;

// The trace row currently expanded (JSON view) in TraceLog
let expandedTraceId = null;

// Which tab is active: 'log' | 'map'
let currentTab = 'log';

// setTimeout handles for the current animation sequence — kept so we can
// cancel a running animation if a new trace fires before the old one finishes
let animTimers = [];

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  currentTab = tab;

  document.getElementById('pane-log').classList.toggle('active', tab === 'log');
  document.getElementById('pane-map').classList.toggle('active', tab === 'map');
  document.getElementById('tab-log').classList.toggle('active', tab === 'log');
  document.getElementById('tab-map').classList.toggle('active', tab === 'map');

  // When the user navigates to TraceMap, immediately render the selected trace
  // (if any). This handles the case where the user fires actions on TraceLog
  // and then switches over to see the map.
  if (tab === 'map' && selectedTrace) {
    animateTrace(selectedTrace);
    renderTraceDetails(selectedTrace);
    updateMapLabel(selectedTrace);
  }
}

// ---------------------------------------------------------------------------
// Action calls — POST to Flask, then refresh
// ---------------------------------------------------------------------------

async function createNote() {
  const title = document.getElementById('note-title').value.trim() || 'Untitled';
  const body  = document.getElementById('note-body').value.trim()  || '';
  await fire('/api/create-note', { title, body }, 'note.create');
}

async function generateNumber() {
  await fire('/api/generate-number', {}, 'number.generate');
}

async function saveMessage() {
  const message = document.getElementById('message-body').value.trim() || 'Hello';
  await fire('/api/save-message', { message }, 'message.save');
}

async function fakeApiCall() {
  await fire('/api/fake-api-call', {}, 'api.fetch');
}

async function triggerError() {
  await fire('/api/trigger-error', {}, 'error.trigger');
}

async function authLogin() {
  const username = document.getElementById('login-username').value.trim() || 'alice';
  await fire('/api/auth-login', { username }, 'auth.login');
}

async function emailCampaign() {
  const subject = document.getElementById('campaign-subject').value.trim() || 'Monthly Newsletter';
  await fire('/api/email-campaign', { subject }, 'email.campaign');
}

async function reportExport() {
  await fire('/api/report-export', {}, 'report.export');
}

async function webhookDispatch() {
  await fire('/api/webhook-dispatch', {}, 'webhook.dispatch');
}

async function importBulk() {
  const rows = parseInt(document.getElementById('import-rows').value, 10) || 100;
  await fire('/api/import-bulk', { rows }, 'import.bulk');
}

async function clearTraces() {
  setStatus('Clearing traces…');
  try {
    await fetch('/api/traces/clear', { method: 'POST' });
    selectedTrace   = null;
    expandedTraceId = null;
    resetMap();
    updateMapLabel(null);
    renderTraceDetails(null);
    await loadTraces();
    setStatus('Traces cleared.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// fire() — shared wrapper: POST → wait → loadTraces → selectTrace(newest)
async function fire(endpoint, body, label) {
  setStatus(`Running ${label}…`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Blocking mode means the trace is already on disk before the response
    // returns. We still wait a short moment so Flask finishes writing.
    setTimeout(async () => {
      await loadTraces();          // rebuilds TraceLog table
      setStatus(`${label} — trace recorded.`);
    }, AUTO_REFRESH_DELAY_MS);

  } catch (err) {
    setStatus(`Error calling ${label}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// loadTraces() — fetch all records from /api/traces, render TraceLog,
//                auto-select the newest trace for TraceMap
// ---------------------------------------------------------------------------

async function loadTraces() {
  try {
    const res = await fetch('/api/traces');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const traces = await res.json();

    renderTable(traces);

    // Auto-select the most recent trace so TraceMap is always showing
    // something useful after each action fires.
    if (traces.length > 0) {
      selectTrace(traces[0]); // traces are newest-first from /api/traces
    }
  } catch (err) {
    setStatus(`Could not load traces: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// selectTrace() — designate a trace as the "selected" one for TraceMap.
//                 Called both on row click (TraceLog) and after loadTraces().
// ---------------------------------------------------------------------------

function selectTrace(trace) {
  selectedTrace = trace;
  updateMapLabel(trace);

  if (currentTab === 'map') {
    animateTrace(trace);
    renderTraceDetails(trace);
  } else {
    // Pre-render the details so switching to TraceMap is instant
    renderTraceDetails(trace);
  }
}

// ---------------------------------------------------------------------------
// renderTable() — builds the TraceLog HTML from an array of trace records
// ---------------------------------------------------------------------------

function renderTable(traces) {
  const container = document.getElementById('trace-container');

  if (!traces || traces.length === 0) {
    container.innerHTML = `<div class="empty-state">No traces yet. Fire an action above.</div>`;
    return;
  }

  let html = `
    <table class="trace-table">
      <colgroup>
        <col style="width:110px"><col style="width:170px"><col style="width:80px">
        <col style="width:105px"><col style="width:115px"><col style="width:170px">
        <col style="width:70px"><col style="width:60px"><col style="width:90px">
      </colgroup>
      <thead><tr>
        <th>Time</th><th>Action</th><th>Kind</th><th>Status</th>
        <th class="num">Duration (ms)</th><th>Trace ID</th>
        <th class="num">Touches</th><th class="num">Errors</th><th>Budget hit</th>
      </tr></thead>
      <tbody>
  `;

  for (const t of traces) {
    const isExpanded = (t.trace_id === expandedTraceId);
    const isSelected = (t.trace_id === selectedTrace?.trace_id);

    const touches    = t.touches || [];
    const errors     = t.errors  || [];
    const touchTip   = touches.map(x => `${x.kind}: ${x.target}`).join('\n') || 'none';
    const dur        = t.duration_ms != null ? t.duration_ms.toFixed(1) : '—';
    const budgeBadge = t.budget_hit
      ? `<span class="badge badge-warn">yes</span>`
      : `<span class="badge badge-muted">no</span>`;
    const shortId = t.trace_id ? t.trace_id.slice(0, 16) + '…' : '—';

    const rowCls = [
      'trace-row',
      isExpanded ? 'expanded' : '',
      t.status === 'failed'  ? 'row-failed'   : '',
      isSelected             ? 'row-selected' : '',
    ].filter(Boolean).join(' ');

    html += `
      <tr class="${rowCls}" data-trace-id="${escapeAttr(t.trace_id)}"
          onclick="onRowClick('${escapeAttr(t.trace_id)}', event)">
        <td class="mono">${formatTime(t.started_at)}</td>
        <td class="mono bold">${escapeHtml(t.action || '—')}</td>
        <td><span class="kind-tag">${escapeHtml(t.kind || '—')}</span></td>
        <td>${makeStatusBadge(t.status)}</td>
        <td class="num mono">${dur}</td>
        <td class="mono dim" title="${escapeAttr(t.trace_id || '')}">${shortId}</td>
        <td class="num mono" title="${escapeAttr(touchTip)}">${touches.length}</td>
        <td class="num mono ${errors.length > 0 ? 'err' : ''}">${errors.length}</td>
        <td>${budgeBadge}</td>
      </tr>
    `;

    if (isExpanded) {
      html += `
        <tr class="detail-row"><td colspan="9">
          <div class="detail-inner">
            <pre class="json-view">${syntaxHighlight(t)}</pre>
          </div>
        </td></tr>
      `;
    }
  }

  html += `</tbody></table>`;
  container.innerHTML = html;
}

// onRowClick — clicking a row does two things:
//   1. Toggles the inline JSON expansion (TraceLog behaviour)
//   2. Selects that trace for TraceMap
function onRowClick(traceId, event) {
  // Toggle JSON expand
  expandedTraceId = (expandedTraceId === traceId) ? null : traceId;

  // Find the full trace object from the current table to pass to selectTrace
  const row = event.currentTarget;
  if (!row) { loadTraces(); return; }

  // Re-render table immediately (shows/hides JSON, updates selected highlight)
  // Then selectTrace to update the map. We need the trace object, so we fetch.
  fetch('/api/traces')
    .then(r => r.json())
    .then(traces => {
      renderTable(traces);
      const t = traces.find(x => x.trace_id === traceId);
      if (t) selectTrace(t);
    });
}

// ---------------------------------------------------------------------------
// TraceMap — SVG animation
// ---------------------------------------------------------------------------

// traceToGraph() — reads a trace record and returns which nodes/edges are active,
//                  plus the ordered sequence in which to animate them.
//
// Mapping rules:
//   actor="user"          → user node + user-app edge
//   app layer             → app node (always present)
//   events[].kind="db"    → db node + app-db edge
//   events[].kind="email" → email node + app-email edge
//   events[].kind="http"  → http node + app-http edge
//   events[].kind="app" && target="rng" → rng node + app-rng edge
//
// The sequence preserves the order events appear in the trace, so the
// animation visually matches what actually happened.

function traceToGraph(trace) {
  const activeNodes = new Set();
  const activeEdges = new Set();

  // Always include the app (the Flask layer) — every trace goes through it.
  activeNodes.add('app');

  // Actor → user node
  if (trace.actor === 'user') {
    activeNodes.add('user');
    activeEdges.add('user-app');
  }

  // Walk events in order to derive service nodes and edges.
  // We deduplicate (a trace may have multiple db events — the node lights up once).
  const seen = new Set();
  for (const evt of (trace.events || [])) {
    if (evt.kind === 'db' && !seen.has('db')) {
      seen.add('db');
      activeNodes.add('db');
      activeEdges.add('app-db');
    } else if (evt.kind === 'email' && !seen.has('email')) {
      seen.add('email');
      activeNodes.add('email');
      activeEdges.add('app-email');
    } else if (evt.kind === 'http' && !seen.has('http')) {
      seen.add('http');
      activeNodes.add('http');
      activeEdges.add('app-http');
    } else if (evt.kind === 'app' && evt.target === 'rng' && !seen.has('rng')) {
      seen.add('rng');
      activeNodes.add('rng');
      activeEdges.add('app-rng');
    }
  }

  // Build an animation sequence: ordered list of {type, id, t} objects.
  // t is the delay in ms from the start of the animation.
  const sequence = [];
  let t = 0;

  if (activeNodes.has('user')) {
    sequence.push({ type: 'node', id: 'user',     t });   t += 180;
    sequence.push({ type: 'edge', id: 'user-app', t });   t += 220;
  }

  sequence.push({ type: 'node', id: 'app', t }); t += 220;

  // Service edges and nodes, in the order they were seen in the events list.
  const serviceOrder = ['db', 'email', 'http', 'rng'];
  const edgeMap = { db: 'app-db', email: 'app-email', http: 'app-http', rng: 'app-rng' };

  for (const svc of serviceOrder) {
    if (activeNodes.has(svc)) {
      sequence.push({ type: 'edge', id: edgeMap[svc], t }); t += 160;
      sequence.push({ type: 'node', id: svc,          t }); t += 100;
    }
  }

  return { activeNodes, activeEdges, sequence };
}

// animateTrace() — main entry point for the TraceMap animation.
//
// Steps:
//   1. Cancel any in-progress animation timers
//   2. Reset all node/edge classes to default
//   3. Mark inactive elements (not in this trace) as dimmed
//   4. Schedule the activation of each element according to the sequence
//   5. Also animate the step labels in the details panel in sync

function animateTrace(trace) {
  if (!trace) { resetMap(); return; }

  // Cancel leftover timers from a previous animation
  animTimers.forEach(clearTimeout);
  animTimers = [];

  const { activeNodes, activeEdges, sequence } = traceToGraph(trace);
  const isError = (trace.status === 'failed');
  const cls     = isError ? 'error' : 'active';

  // Reset all elements to their neutral (non-highlighted) state
  resetMap();

  // Dim elements not involved in this trace so the active path stands out
  ALL_NODES.forEach(id => {
    if (!activeNodes.has(id))
      document.getElementById(`map-node-${id}`)?.classList.add('inactive');
  });
  ALL_EDGES.forEach(id => {
    if (!activeEdges.has(id))
      document.getElementById(`map-edge-${id}`)?.classList.add('inactive');
  });

  // Schedule each element's activation according to the sequence
  for (const { type, id, t } of sequence) {
    const timer = setTimeout(() => {
      const el = document.getElementById(`map-${type}-${id}`);
      if (el) el.classList.add(cls);
    }, t);
    animTimers.push(timer);
  }

  // Animate step labels in the detail panel in sync with the graph.
  // Steps start appearing slightly after the app node activates.
  const appActivateAt = sequence.find(s => s.type === 'node' && s.id === 'app')?.t ?? 0;
  animateStepLabels(trace.steps || [], appActivateAt + 150);
}

// animateStepLabels() — highlights step items in the detail panel one by one,
//                        timed to match when nodes are lighting up on the graph.

function animateStepLabels(steps, baseDelay) {
  const STEP_INTERVAL = 220; // ms between each step lighting up

  // Mark all steps as pending first
  document.querySelectorAll('.step-item').forEach(el => {
    el.classList.remove('step-done', 'step-active', 'step-pending');
    el.classList.add('step-pending');
  });

  steps.forEach((_, i) => {
    // Mark step i as "active" (currently running)
    const activateTimer = setTimeout(() => {
      document.querySelectorAll('.step-item').forEach((el, j) => {
        el.classList.remove('step-done', 'step-active', 'step-pending');
        if (j < i)      el.classList.add('step-done');
        else if (j === i) el.classList.add('step-active');
        else              el.classList.add('step-pending');
      });
    }, baseDelay + i * STEP_INTERVAL);

    animTimers.push(activateTimer);

    // After the last step, mark everything done
    if (i === steps.length - 1) {
      const doneTimer = setTimeout(() => {
        document.querySelectorAll('.step-item').forEach(el => {
          el.classList.remove('step-done', 'step-active', 'step-pending');
          el.classList.add('step-done');
        });
      }, baseDelay + (i + 1) * STEP_INTERVAL);
      animTimers.push(doneTimer);
    }
  });
}

// resetMap() — remove all state classes, returning every node/edge to neutral
function resetMap() {
  document.querySelectorAll('.map-node, .map-edge').forEach(el => {
    el.classList.remove('active', 'error', 'inactive');
  });
}

// ---------------------------------------------------------------------------
// renderTraceDetails() — populates the panel below the SVG with steps,
//                         events, touches, and errors from the selected trace
// ---------------------------------------------------------------------------

function renderTraceDetails(trace) {
  const container = document.getElementById('map-details');
  if (!container) return;

  if (!trace) {
    container.innerHTML = `<div class="map-details-empty">Select a trace from TraceLog or fire an action.</div>`;
    return;
  }

  const steps   = trace.steps   || [];
  const events  = trace.events  || [];
  const touches = trace.touches || [];
  const errors  = trace.errors  || [];

  // Steps column — each item starts as pending; animateStepLabels() drives
  // the done/active state transitions during the animation.
  const stepsHtml = steps.length === 0
    ? `<div class="detail-none">no steps recorded</div>`
    : steps.map((s, i) => `
        <div class="step-item step-pending" data-step-index="${i}">
          <span class="step-check"></span>
          <span class="step-label">${escapeHtml(s.label)}</span>
        </div>`).join('');

  // Events column — shows kind / operation → target, plus any extra fields
  const eventsHtml = events.length === 0
    ? `<div class="detail-none">no events recorded</div>`
    : events.map(e => {
        // Collect interesting extra fields (rows, status_code, etc.) beyond
        // the standard set that are already shown inline.
        const stdFields = new Set(['event_id','parent_event_id','kind','action',
          'operation','target','status','started_at','ended_at','duration_ms',
          'result','error','depth']);
        const extra = Object.entries(e)
          .filter(([k]) => !stdFields.has(k))
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(' · ');

        return `
          <div class="event-item">
            <span class="ev-kind">${escapeHtml(e.kind || '—')}</span>
            ${e.operation ? `<span class="ev-op">${escapeHtml(e.operation)}</span>` : ''}
            ${e.target    ? `<span class="ev-arrow">→</span><span class="ev-target">${escapeHtml(e.target)}</span>` : ''}
            ${extra       ? `<span class="ev-meta">${escapeHtml(extra)}</span>` : ''}
          </div>`;
      }).join('');

  // Touches column
  const touchesHtml = touches.length === 0
    ? `<div class="detail-none">no touches recorded</div>`
    : touches.map(t => `
        <div class="touch-item">
          <span class="touch-kind">${escapeHtml(t.kind)}</span>
          <span class="touch-target">${escapeHtml(t.target)}</span>
        </div>`).join('');

  // Errors column
  const errorsHtml = errors.length === 0
    ? `<div class="detail-none">none</div>`
    : errors.map(e => `
        <div class="error-item">
          <span class="err-type">${escapeHtml(e.type || 'Error')}</span>
          <div class="err-msg">${escapeHtml(e.message || '')}</div>
        </div>`).join('');

  const dur = trace.duration_ms != null ? `${trace.duration_ms.toFixed(1)} ms` : '—';

  container.innerHTML = `
    <div class="detail-header">
      <span class="detail-action">${escapeHtml(trace.action || '—')}</span>
      ${makeStatusBadge(trace.status)}
      <span class="detail-dur">${dur}</span>
    </div>
    <div class="detail-columns">
      <div class="detail-col">
        <div class="detail-col-title">Steps (${steps.length})</div>
        ${stepsHtml}
      </div>
      <div class="detail-col">
        <div class="detail-col-title">Events (${events.length})</div>
        ${eventsHtml}
      </div>
      <div class="detail-col">
        <div class="detail-col-title">Touches (${touches.length})</div>
        ${touchesHtml}
      </div>
      <div class="detail-col">
        <div class="detail-col-title">Errors (${errors.length})</div>
        ${errorsHtml}
      </div>
    </div>
  `;
}

// updateMapLabel() — updates the detail pane header with the selected trace
function updateMapLabel(trace) {
  const el = document.getElementById('map-label');
  if (!el) return;

  if (!trace) {
    el.textContent = 'Fire an action or click a trace row.';
    return;
  }

  const dur = trace.duration_ms != null ? `${trace.duration_ms.toFixed(1)} ms` : '—';
  el.innerHTML = `
    <span style="font-weight:700;color:var(--text);font-family:var(--mono)">${escapeHtml(trace.action)}</span>
    ${makeStatusBadge(trace.status)}
    <span style="color:var(--muted)">${dur}</span>
  `;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function makeStatusBadge(status) {
  const map = { completed: 'badge-ok', failed: 'badge-err', running: 'badge-run' };
  const cls = map[status] || 'badge-muted';
  return `<span class="badge ${cls}">${escapeHtml(status || 'unknown')}</span>`;
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d  = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch { return iso; }
}

// syntaxHighlight() — JSON with coloured spans for the inline JSON view
function syntaxHighlight(obj) {
  const raw = JSON.stringify(obj, null, 2);
  const escaped = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^"\\])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    m => {
      if (/^"/.test(m)) return /:$/.test(m) ? `<span class="json-key">${m}</span>` : `<span class="json-str">${m}</span>`;
      if (/true|false/.test(m)) return `<span class="json-bool">${m}</span>`;
      if (/null/.test(m))       return `<span class="json-null">${m}</span>`;
      return `<span class="json-num">${m}</span>`;
    }
  );
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function setStatus(msg) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = msg;
}

// ---------------------------------------------------------------------------
// Sidebar — action search filter
// ---------------------------------------------------------------------------

function filterActions(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#sidebar-actions .action-card').forEach(card => {
    const label = (card.dataset.label || '').toLowerCase();
    card.style.display = (!q || label.includes(q)) ? '' : 'none';
  });
}

// ---------------------------------------------------------------------------
// Column drag-to-resize (shared factory)
// ---------------------------------------------------------------------------

// makeDragResizer(handleId, panelId, growsLeft)
//   growsLeft=false → dragging right widens the panel (left sidebar)
//   growsLeft=true  → dragging left widens the panel (right detail pane)
function makeDragResizer(handleId, panelId, growsLeft) {
  const handle = document.getElementById(handleId);
  const panel  = document.getElementById(panelId);
  if (!handle || !panel) return;

  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW  = growsLeft
      ? Math.max(180, Math.min(440, startW - delta))   // right panel
      : Math.max(160, Math.min(460, startW + delta));   // left sidebar
    panel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

function initSidebarDrag() {
  makeDragResizer('drag-handle', 'sidebar', false);
  makeDragResizer('drag-handle-right', 'detail-pane', true);
}

// ---------------------------------------------------------------------------
// TraceMap — zoom / pan
// ---------------------------------------------------------------------------

let mapScale = 1, mapPanX = 0, mapPanY = 0;
let mapPanning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

function applyMapTransform() {
  const vp = document.getElementById('map-viewport');
  if (vp) {
    vp.setAttribute('transform',
      `translate(${mapPanX.toFixed(2)},${mapPanY.toFixed(2)}) scale(${mapScale.toFixed(3)})`);
  }
  const lbl = document.getElementById('map-zoom-label');
  if (lbl) lbl.textContent = Math.round(mapScale * 100) + '%';
}

// Zoom toward a point in SVG viewBox coordinates (cx, cy).
// Called by +/− buttons (cx/cy default to canvas centre) and wheel.
function mapZoom(factor, cx, cy) {
  if (cx === undefined) cx = 400;
  if (cy === undefined) cy = 230;
  const newScale     = Math.max(0.2, Math.min(5, mapScale * factor));
  const actualFactor = newScale / mapScale;
  mapPanX  = cx - (cx - mapPanX) * actualFactor;
  mapPanY  = cy - (cy - mapPanY) * actualFactor;
  mapScale = newScale;
  applyMapTransform();
}

function mapZoomReset() {
  mapScale = 1; mapPanX = 0; mapPanY = 0;
  applyMapTransform();
}

function initMapZoomPan() {
  const svg = document.getElementById('trace-map-svg');
  if (!svg) return;

  // Wheel zoom toward cursor
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect   = svg.getBoundingClientRect();
    const cx     = (e.clientX - rect.left)  / rect.width  * 800;
    const cy     = (e.clientY - rect.top)   / rect.height * 460;
    const factor = e.deltaY < 0 ? 1.1 : 0.909;
    mapZoom(factor, cx, cy);
  }, { passive: false });

  // Drag to pan
  svg.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    mapPanning  = true;
    panStartX   = e.clientX;
    panStartY   = e.clientY;
    panOriginX  = mapPanX;
    panOriginY  = mapPanY;
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!mapPanning) return;
    const rect  = svg.getBoundingClientRect();
    const scaleX = 800 / rect.width;
    const scaleY = 460 / rect.height;
    mapPanX = panOriginX + (e.clientX - panStartX) * scaleX;
    mapPanY = panOriginY + (e.clientY - panStartY) * scaleY;
    applyMapTransform();
  });

  document.addEventListener('mouseup', () => {
    if (!mapPanning) return;
    mapPanning = false;
    svg.style.cursor = '';
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  loadTraces();
  initSidebarDrag();
  initMapZoomPan();
});
