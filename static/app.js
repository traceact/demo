// app.js — TraceAct Demo
//
// Two main tabs:
//   Traces  — live table of all trace records + row-click inspector
//   Explore — sinks dashboard (JSONL/SQLite/HTTP/OTLP) + TraceLog query builder
//
// Data flow:
//   User clicks "Run" → fire() → loadTraces() → renderTable()
//   Row click → selectTrace() → renderTraceDetails() (inspector pane)
//   Explore tab open → refreshSinkStats() on 2s interval

// ---------------------------------------------------------------------------
// Constants & global state
// ---------------------------------------------------------------------------

const AUTO_REFRESH_DELAY_MS = 300;

let allTraces       = [];      // full array from /api/traces (newest first)
let selectedTrace   = null;    // trace currently shown in inspector
let expandedTraceId = null;    // trace row with JSON expanded
let currentTab      = 'traces';

let sinkStatsInterval = null;  // setInterval handle for Explore tab refresh
let lastOtlpLog = [];          // latest /api/sink/otlp-log result

// Query builder state
let queryFilters        = [];
let queryFilterIdSeq    = 0;
let queryHasRun         = false;

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  currentTab = tab;

  document.getElementById('pane-traces').classList.toggle('active',  tab === 'traces');
  document.getElementById('pane-explore').classList.toggle('active', tab === 'explore');
  document.getElementById('pane-map').classList.toggle('active',     tab === 'map');
  document.getElementById('tab-traces').classList.toggle('active',   tab === 'traces');
  document.getElementById('tab-explore').classList.toggle('active',  tab === 'explore');
  document.getElementById('tab-map').classList.toggle('active',      tab === 'map');

  if (tab === 'explore') {
    refreshSinkStats();
    if (!sinkStatsInterval) {
      sinkStatsInterval = setInterval(refreshSinkStats, 2000);
    }
  } else {
    if (sinkStatsInterval) {
      clearInterval(sinkStatsInterval);
      sinkStatsInterval = null;
    }
  }

  if (tab === 'map') renderTraceMap(selectedTrace);
}

// ---------------------------------------------------------------------------
// Action functions — POST to Flask, then refresh
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

async function sampledFailure() {
  await fire('/api/sampled-failure', {}, 'sampled.failure');
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

async function orderSubmit() {
  await fire('/api/order-submit', {}, 'order.submit');
}

async function clearTraces() {
  setStatus('Clearing traces…');
  try {
    await fetch('/api/traces/clear', { method: 'POST' });
    allTraces       = [];
    selectedTrace   = null;
    expandedTraceId = null;
    renderTraceDetails(null);
    updateMapLabel(null);
    renderTraceMap(null);
    await loadTraces();
    setStatus('Traces cleared.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

async function fire(endpoint, body, label) {
  setStatus(`Running ${label}…`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTimeout(async () => {
      await loadTraces();
      setStatus(`${label} — trace recorded.`);
    }, AUTO_REFRESH_DELAY_MS);
  } catch (err) {
    setStatus(`Error calling ${label}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// loadTraces — fetch, store, render
// ---------------------------------------------------------------------------

async function loadTraces() {
  try {
    const res = await fetch('/api/traces');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allTraces = await res.json();

    const query = document.getElementById('trace-search')?.value || '';
    renderTable(filterBySearch(allTraces, query));

    if (allTraces.length > 0) {
      selectTrace(allTraces[0]);
    }
  } catch (err) {
    setStatus(`Could not load traces: ${err.message}`);
  }
}

// filterBySearch — client-side substring filter across action/kind/status
function filterBySearch(traces, query) {
  if (!query.trim()) return traces;
  const q = query.trim().toLowerCase();
  return traces.filter(t =>
    (t.action  || '').toLowerCase().includes(q) ||
    (t.kind    || '').toLowerCase().includes(q) ||
    (t.status  || '').toLowerCase().includes(q)
  );
}

function filterTable(query) {
  renderTable(filterBySearch(allTraces, query));
}

// ---------------------------------------------------------------------------
// selectTrace — designate the "active" trace for the inspector
// ---------------------------------------------------------------------------

function selectTrace(trace) {
  selectedTrace = trace;
  updateMapLabel(trace);
  renderTraceDetails(trace);
  if (currentTab === 'map') renderTraceMap(trace);
}

// ---------------------------------------------------------------------------
// renderTable — build TraceLog HTML
// ---------------------------------------------------------------------------

function renderTable(traces) {
  const container = document.getElementById('trace-container');

  if (!traces || traces.length === 0) {
    container.innerHTML = `<div class="empty-state">No traces yet — fire an action to get started.</div>`;
    return;
  }

  let html = `
    <table class="trace-table">
      <colgroup>
        <col style="width:100px"><col style="width:160px"><col style="width:90px">
        <col style="width:110px"><col style="width:100px"><col style="width:60px"><col style="width:55px">
      </colgroup>
      <thead><tr>
        <th>Time</th>
        <th>Action</th>
        <th>Kind</th>
        <th>Status</th>
        <th class="num">Duration (ms)</th>
        <th class="num">Touches</th>
        <th class="num">Errors</th>
      </tr></thead>
      <tbody>
  `;

  for (const t of traces) {
    const isExpanded = (t.trace_id === expandedTraceId);
    const isSelected = (t.trace_id === selectedTrace?.trace_id);
    const touches    = t.touches || [];
    const errors     = t.errors  || [];
    const dur        = t.duration_ms != null ? t.duration_ms.toFixed(1) : '—';
    const kindCls    = `badge badge-${escapeHtml(t.kind || 'app')}`;

    const rowCls = [
      'trace-row',
      isExpanded ? 'expanded'     : '',
      t.status === 'failed' ? 'row-failed'   : '',
      isSelected            ? 'row-selected' : '',
    ].filter(Boolean).join(' ');

    html += `
      <tr class="${rowCls}" onclick="onRowClick('${escapeAttr(t.trace_id)}', event)">
        <td class="mono dim">${formatTime(t.started_at)}</td>
        <td class="mono bold">${escapeHtml(t.action || '—')}</td>
        <td><span class="${kindCls}">${escapeHtml(t.kind || '—')}</span></td>
        <td>${makeStatusBadge(t.status)}</td>
        <td class="num mono">${dur}</td>
        <td class="num mono">${touches.length}</td>
        <td class="num mono ${errors.length > 0 ? 'err' : ''}">${errors.length}</td>
      </tr>
    `;

    if (isExpanded) {
      html += `
        <tr class="detail-row"><td colspan="7">
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

function onRowClick(traceId, event) {
  expandedTraceId = (expandedTraceId === traceId) ? null : traceId;
  fetch('/api/traces')
    .then(r => r.json())
    .then(traces => {
      allTraces = traces;
      const query = document.getElementById('trace-search')?.value || '';
      renderTable(filterBySearch(traces, query));
      const t = traces.find(x => x.trace_id === traceId);
      if (t) selectTrace(t);
    });
}

// ---------------------------------------------------------------------------
// Inspector panel — renderTraceDetails + updateMapLabel
// ---------------------------------------------------------------------------

function renderTraceDetails(trace) {
  const container = document.getElementById('map-details');
  if (!container) return;

  if (!trace) {
    container.innerHTML = `<div class="map-details-empty">Select a trace from the log or fire an action.</div>`;
    return;
  }

  const steps   = trace.steps          || [];
  const events  = trace.events         || [];
  const touches = trace.touches        || [];
  const errors  = trace.errors         || [];
  const corrId  = trace.correlation_id || null;
  const upstreamId = trace.upstream_trace_id || null;

  const stepsHtml = steps.length === 0
    ? `<div class="detail-none">no steps recorded</div>`
    : steps.map((s, i) => `
        <div class="step-item step-done" data-step-index="${i}">
          <span class="step-check"></span>
          <span class="step-label">${escapeHtml(s.label)}</span>
        </div>`).join('');

  const eventsHtml = events.length === 0
    ? `<div class="detail-none">no events recorded</div>`
    : events.map(e => {
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

  const touchesHtml = touches.length === 0
    ? `<div class="detail-none">no touches recorded</div>`
    : touches.map(t => `
        <div class="touch-item">
          <span class="touch-kind">${escapeHtml(t.kind)}</span>
          <span class="touch-target">${escapeHtml(t.target)}</span>
        </div>`).join('');

  const errorsHtml = errors.length === 0
    ? `<div class="detail-none">none</div>`
    : errors.map(e => `
        <div class="error-item">
          <span class="err-type">${escapeHtml(e.type || 'Error')}</span>
          <div class="err-msg">${escapeHtml(e.message || '')}</div>
        </div>`).join('');

  const dur = trace.duration_ms != null ? `${trace.duration_ms.toFixed(1)} ms` : '—';

  const lineageHtml = (corrId || upstreamId) ? `
    <div class="lineage-section">
      ${corrId     ? `<div class="lineage-item"><span class="lineage-key">Corr</span><span class="lineage-val">${escapeHtml(corrId)}</span></div>` : ''}
      ${upstreamId ? `<div class="lineage-item"><span class="lineage-key">Upstream</span><span class="lineage-val">${escapeHtml(upstreamId)}</span></div>` : ''}
    </div>` : '';

  container.innerHTML = `
    ${lineageHtml}
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

function updateMapLabel(trace) {
  const el = document.getElementById('map-label');
  if (!el) return;
  if (!trace) {
    el.textContent = 'Fire an action or click a trace row.';
    return;
  }
  const dur = trace.duration_ms != null ? `${trace.duration_ms.toFixed(1)} ms` : '—';
  el.innerHTML = `
    <div class="map-label-summary">
      <span style="font-weight:700;color:var(--text)">${escapeHtml(trace.action)}</span>
      ${makeStatusBadge(trace.status)}
      <span style="color:var(--text-dim)">${dur}</span>
    </div>
    <button class="btn btn-xs view-map-btn" onclick="switchTab('map')">View map →</button>
  `;
}

// ---------------------------------------------------------------------------
// Open in viewer (Traces tab — no filters)
// ---------------------------------------------------------------------------

async function openInViewer() {
  try {
    const res = await fetch('/api/tracelog/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {} }),
    });
    const { url } = await res.json();
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    setStatus(`Could not open viewer: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Map tab — trace visualizer
// ---------------------------------------------------------------------------

function renderTraceMap(trace) {
  const container = document.getElementById('map-canvas');
  if (!container) return;

  const labelEl = document.getElementById('map-pane-label');

  if (!trace) {
    container.innerHTML = `<div class="map-empty">Select a trace from the Traces tab and click "View map →" to visualize it here.</div>`;
    if (labelEl) labelEl.textContent = 'Select a trace to view its map.';
    mapZoom.lastTraceId = null;
    resetMapZoom();
    return;
  }

  if (labelEl) {
    const dur = trace.duration_ms != null ? `${trace.duration_ms.toFixed(1)} ms` : '—';
    labelEl.innerHTML = `<strong style="color:var(--text)">${escapeHtml(trace.action)}</strong>${makeStatusBadge(trace.status)}<span style="color:var(--text-faint)">${dur}</span>`;
  }

  const steps   = trace.steps   || [];
  const touches = trace.touches || [];
  const actor   = trace.actor   || null;

  // Layout constants
  const W         = Math.max(container.clientWidth, 500);
  const ACTOR_R   = 30;
  const BOX_W     = 210;
  const BOX_PAD_T = 36;
  const BOX_PAD_B = 16;
  const STEP_H    = 22;
  const RES_H     = 44;
  const RES_GAP   = 12;

  const BOX_H = BOX_PAD_T + Math.max(steps.length, 1) * STEP_H + BOX_PAD_B;
  const totalResH = touches.length > 0
    ? touches.length * RES_H + (touches.length - 1) * RES_GAP : 0;

  const contentH = Math.max(BOX_H, totalResH, 80);
  const H        = contentH + 80;
  const midY     = H / 2;

  const hasActor  = !!actor;
  const actorCX   = hasActor ? 44 : 0;
  const BOX_LEFT  = hasActor ? actorCX + ACTOR_R + 60 : 50;
  const BOX_RIGHT = BOX_LEFT + BOX_W;
  const RES_LEFT  = BOX_RIGHT + 110;
  const RES_W     = Math.max(100, Math.min(180, W - RES_LEFT - 20));

  const boxTop    = midY - BOX_H / 2;
  const resStartY = midY - totalResH / 2;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}" style="display:block">`;

  svg += `<defs>
    <marker id="ta-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <polygon points="0 0, 7 3.5, 0 7" fill="var(--border-strong)" />
    </marker>
  </defs>`;

  // Actor
  if (hasActor) {
    svg += `
      <circle cx="${actorCX}" cy="${midY}" r="${ACTOR_R}"
              fill="var(--bg-card)" stroke="var(--border-strong)" stroke-width="1.5" />
      <text x="${actorCX}" y="${midY - 7}" text-anchor="middle" dominant-baseline="middle"
            font-size="8.5" font-weight="600" fill="var(--text-faint)" font-family="var(--mono)">ACTOR</text>
      <text x="${actorCX}" y="${midY + 8}" text-anchor="middle" dominant-baseline="middle"
            font-size="10.5" fill="var(--text-dim)" font-family="var(--mono)">${escapeHtml(truncateStr(actor, 8))}</text>
      <line x1="${actorCX + ACTOR_R}" y1="${midY}" x2="${BOX_LEFT - 4}" y2="${midY}"
            stroke="var(--border-strong)" stroke-width="1.5" marker-end="url(#ta-arrow)" />
    `;
  }

  // Action box
  const boxKindColor = kindCssVar(trace.kind);
  const statusColor  = trace.status === 'completed' ? 'var(--status-completed)'
                     : trace.status === 'failed'    ? 'var(--status-failed)'
                     : 'var(--text-faint)';

  svg += `
    <rect x="${BOX_LEFT}" y="${boxTop}" width="${BOX_W}" height="${BOX_H}" rx="7"
          fill="var(--bg-card)" stroke="${boxKindColor}" stroke-width="1.5" />
    <text x="${BOX_LEFT + 12}" y="${boxTop + 19}" dominant-baseline="middle"
          font-size="12.5" font-weight="700" fill="var(--text)" font-family="var(--mono)">${escapeHtml(truncateStr(trace.action, 18))}</text>
    <rect x="${BOX_RIGHT - 68}" y="${boxTop + 6}" width="60" height="16" rx="4"
          fill="transparent" stroke="${statusColor}" stroke-width="1" opacity="0.7" />
    <text x="${BOX_RIGHT - 38}" y="${boxTop + 14}" text-anchor="middle" dominant-baseline="middle"
          font-size="9" fill="${statusColor}" font-family="var(--mono)">${escapeHtml(trace.status || '?')}</text>
    <line x1="${BOX_LEFT + 8}" y1="${boxTop + 30}" x2="${BOX_RIGHT - 8}" y2="${boxTop + 30}"
          stroke="var(--border)" stroke-width="1" />
  `;

  // Steps
  if (steps.length === 0) {
    svg += `<text x="${BOX_LEFT + 14}" y="${boxTop + BOX_PAD_T + STEP_H / 2}" dominant-baseline="middle"
          font-size="10.5" fill="var(--text-faint)" font-family="var(--mono)">no steps recorded</text>`;
  }
  steps.forEach((s, i) => {
    const sy = boxTop + BOX_PAD_T + i * STEP_H + STEP_H / 2;
    svg += `
      <text x="${BOX_LEFT + 14}" y="${sy}" dominant-baseline="middle"
            font-size="10" fill="var(--accent)" font-family="var(--mono)">✓</text>
      <text x="${BOX_LEFT + 28}" y="${sy}" dominant-baseline="middle"
            font-size="10.5" fill="var(--text-dim)" font-family="var(--mono)">${escapeHtml(truncateStr(s.label, 22))}</text>
    `;
  });

  // Resource nodes + bezier lines
  const M = touches.length;
  touches.forEach((touch, i) => {
    const ry    = resStartY + i * (RES_H + RES_GAP);
    const rmidY = ry + RES_H / 2;
    const exitY = M === 1 ? midY : boxTop + 15 + (BOX_H - 30) * i / (M - 1);
    const midX  = BOX_RIGHT + (RES_LEFT - BOX_RIGHT) * 0.5;

    svg += `
      <path d="M ${BOX_RIGHT} ${exitY} C ${midX} ${exitY} ${midX} ${rmidY} ${RES_LEFT - 4} ${rmidY}"
            fill="none" stroke="var(--border-strong)" stroke-width="1.5" marker-end="url(#ta-arrow)" />
    `;

    const tkindCol = kindCssVar(touch.kind);
    svg += `
      <rect x="${RES_LEFT}" y="${ry}" width="${RES_W}" height="${RES_H}" rx="6"
            fill="var(--bg-card)" stroke="${tkindCol}" stroke-width="1.5" />
      <text x="${RES_LEFT + 10}" y="${ry + 14}" dominant-baseline="middle"
            font-size="9" font-weight="700" fill="${tkindCol}" font-family="var(--mono)">${escapeHtml((touch.kind || '').toUpperCase())}</text>
      <text x="${RES_LEFT + 10}" y="${ry + 30}" dominant-baseline="middle"
            font-size="11.5" fill="var(--text)" font-family="var(--mono)">${escapeHtml(truncateStr(touch.target || '—', 20))}</text>
    `;
  });

  if (M === 0) {
    svg += `<text x="${RES_LEFT}" y="${midY}" dominant-baseline="middle"
          font-size="11" fill="var(--text-faint)" font-family="var(--mono)">no resources touched</text>`;
  }

  svg += `</svg>`;
  container.innerHTML = svg;

  // A new trace starts at 1×; re-rendering the same one keeps the current view.
  if (trace.trace_id !== mapZoom.lastTraceId) {
    mapZoom.scale = 1; mapZoom.tx = 0; mapZoom.ty = 0;
    mapZoom.lastTraceId = trace.trace_id;
  }
  applyMapTransform();
}

// ---------------------------------------------------------------------------
// Map zoom and pan — wheel to zoom around the cursor, drag to pan.
// ---------------------------------------------------------------------------

const mapZoom = { scale: 1, tx: 0, ty: 0, lastTraceId: null };

function applyMapTransform() {
  const canvas = document.getElementById('map-canvas');
  if (canvas) {
    canvas.style.transform =
      `translate(${mapZoom.tx}px, ${mapZoom.ty}px) scale(${mapZoom.scale})`;
  }
}

/* Zoom by `factor` about a viewport point, keeping whatever sits under that
 * point pinned in place. Defaults to the centre of the visible area, which is
 * what the toolbar buttons want.
 *
 * The anchor is measured against the canvas's own rect, which already reflects
 * the current transform. That keeps the maths independent of the wrapper's
 * padding and borders, which otherwise offset the transform origin and make
 * each wheel step drift. */
function zoomMapBy(factor, clientX, clientY) {
  const wrap = document.getElementById('map-canvas-wrap');
  const canvas = document.getElementById('map-canvas');
  if (!wrap || !canvas) return;

  const wrapRect = wrap.getBoundingClientRect();
  if (clientX == null) clientX = wrapRect.left + wrap.clientWidth / 2;
  if (clientY == null) clientY = wrapRect.top + wrap.clientHeight / 2;

  const next = Math.max(0.2, Math.min(5, mapZoom.scale * factor));
  const rect = canvas.getBoundingClientRect();
  const contentX = (clientX - rect.left) / mapZoom.scale;
  const contentY = (clientY - rect.top) / mapZoom.scale;

  mapZoom.tx += (clientX - contentX * next) - rect.left;
  mapZoom.ty += (clientY - contentY * next) - rect.top;
  mapZoom.scale = next;
  applyMapTransform();
}

function resetMapZoom() {
  mapZoom.scale = 1; mapZoom.tx = 0; mapZoom.ty = 0;
  applyMapTransform();
}

function wireMapZoom() {
  const wrap = document.getElementById('map-canvas-wrap');
  if (!wrap) return;

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomMapBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  // Pan. Tracked on window so a fast drag that leaves the pane still ends.
  let drag = null;
  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX - mapZoom.tx, y: e.clientY - mapZoom.ty };
    wrap.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    mapZoom.tx = e.clientX - drag.x;
    mapZoom.ty = e.clientY - drag.y;
    applyMapTransform();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    wrap.classList.remove('dragging');
  });

  const btn = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };
  btn('zoom-in',    () => zoomMapBy(1.25));
  btn('zoom-out',   () => zoomMapBy(1 / 1.25));
  btn('zoom-reset', resetMapZoom);
}

function kindCssVar(kind) {
  const map = {
    app: 'var(--kind-app)', db: 'var(--kind-db)', db_table: 'var(--kind-db)',
    http: 'var(--kind-http)', http_endpoint: 'var(--kind-http)',
    model: 'var(--kind-model)', job: 'var(--kind-job)',
    email: 'var(--kind-email)', email_service: 'var(--kind-email)',
  };
  return map[kind] || 'var(--border-strong)';
}

function truncateStr(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// ---------------------------------------------------------------------------
// Explore tab — sink stats dashboard
// ---------------------------------------------------------------------------

async function refreshSinkStats() {
  try {
    const [statsRes, otlpRes] = await Promise.all([
      fetch('/api/sink-stats'),
      fetch('/api/sink/otlp-log'),
    ]);
    const stats = await statsRes.json();
    lastOtlpLog = await otlpRes.json();
    updateSinkCards(stats, lastOtlpLog);
  } catch (_) {
    // silently ignore during page load
  }
}

function dotClass(received, failed) {
  if (failed > 0) return 'failed';
  if (received > 0) return 'active';
  return '';
}

function updateSinkCards(stats, otlpLog) {
  // JSONL
  const jsonlKb = stats.jsonl?.size_kb ?? 0;
  setSinkDot('jsonl', jsonlKb > 0 ? 'active' : '');
  document.getElementById('sink-stat-jsonl').textContent = `${jsonlKb} KB`;

  // SQLite
  const sqliteRows = stats.sqlite?.rows ?? 0;
  setSinkDot('sqlite', sqliteRows > 0 ? 'active' : '');
  document.getElementById('sink-stat-sqlite').textContent = `${sqliteRows} rows`;

  // HTTP
  const httpRec    = stats.http?.received ?? 0;
  const httpFailed = stats.http?.failed   ?? 0;
  setSinkDot('http', dotClass(httpRec, httpFailed));
  document.getElementById('sink-stat-http').textContent = `${httpRec} received`;
  const httpDetail = document.getElementById('sink-detail-http');
  if (httpFailed > 0) {
    httpDetail.innerHTML = `<span class="sink-failed-count">${httpFailed} failed</span>`;
  } else if (httpRec > 0) {
    // Show action name from latest delivery if available
    fetch('/api/sink/http-log')
      .then(r => r.json())
      .then(log => {
        const last = log[0];
        const action = last?.payload?.action || '';
        httpDetail.textContent = action ? `Last: ${action}` : `${httpRec} deliveries OK`;
      })
      .catch(() => {});
  } else {
    httpDetail.textContent = 'Waiting for delivery…';
  }

  // OTLP
  const otlpRec    = stats.otlp?.received ?? 0;
  const otlpFailed = stats.otlp?.failed   ?? 0;
  setSinkDot('otlp', dotClass(otlpRec, otlpFailed));
  document.getElementById('sink-stat-otlp').textContent = `${otlpRec} received`;
  const otlpDetail   = document.getElementById('sink-detail-otlp');
  const otlpToggle   = document.getElementById('otlp-payload-toggle');
  if (otlpFailed > 0) {
    otlpDetail.innerHTML = `<span class="sink-failed-count">${otlpFailed} failed</span>`;
  } else if (otlpRec > 0) {
    const last = otlpLog[0];
    otlpDetail.textContent = last?.span_name ? `Last: ${last.span_name}` : `${otlpRec} deliveries OK`;
    otlpToggle.style.display = 'block';
  } else {
    otlpDetail.textContent  = 'Waiting for delivery…';
    otlpToggle.style.display = 'none';
  }

  // Signals — sampled-out error count (a trace-level signal, not a sink).
  const sampledOut = stats.sampled_out?.count ?? 0;
  setSinkDot('sampled', sampledOut > 0 ? 'active' : '');
  document.getElementById('stat-sampled-out').textContent = sampledOut;
}

function setSinkDot(name, cls) {
  const dot = document.getElementById(`sink-dot-${name}`);
  if (!dot) return;
  dot.className = 'sink-dot' + (cls ? ` ${cls}` : '');
}

function openOtlpModal() {
  const modal = document.getElementById('otlp-modal');
  const pre   = document.getElementById('otlp-modal-pre');
  if (lastOtlpLog[0]?.full_payload) {
    pre.textContent = JSON.stringify(lastOtlpLog[0].full_payload, null, 2);
  }
  modal.style.display = 'flex';
  document.addEventListener('keydown', _otlpEscHandler);
}

function closeOtlpModal(event) {
  if (event && event.target !== document.getElementById('otlp-modal') &&
      event.type !== 'click') return;
  if (event && event.target !== document.getElementById('otlp-modal') &&
      !event.target.classList.contains('otlp-modal-close')) return;
  document.getElementById('otlp-modal').style.display = 'none';
  document.removeEventListener('keydown', _otlpEscHandler);
}

function _otlpEscHandler(e) {
  if (e.key === 'Escape') closeOtlpModal({ target: document.getElementById('otlp-modal') });
}

// ---------------------------------------------------------------------------
// Explore tab — TraceLog query builder
// ---------------------------------------------------------------------------

const FILTER_FIELDS = ['status', 'kind', 'action', 'actor', 'correlation_id', 'upstream_trace_id'];
const FILTER_OPS    = [
  { value: 'eq',         label: '=' },
  { value: 'contains',   label: 'contains' },
  { value: 'startswith', label: 'starts with' },
  { value: 'endswith',   label: 'ends with' },
];

function addFilter() {
  if (queryFilters.length >= 3) return;
  const id = ++queryFilterIdSeq;
  queryFilters.push({ id, field: 'status', op: 'eq', value: '' });
  renderQueryFilters();
  updateQuerySnippet();
  if (queryFilters.length >= 3) {
    document.getElementById('query-add-btn').style.display = 'none';
  }
}

function removeFilter(id) {
  queryFilters = queryFilters.filter(f => f.id !== id);
  renderQueryFilters();
  updateQuerySnippet();
  document.getElementById('query-add-btn').style.display = '';
}

function updateFilter(id, key, value) {
  const f = queryFilters.find(f => f.id === id);
  if (f) f[key] = value;
  updateQuerySnippet();
}

function renderQueryFilters() {
  const container = document.getElementById('query-filters');
  container.innerHTML = queryFilters.map(f => `
    <div class="filter-row">
      <select onchange="updateFilter(${f.id}, 'field', this.value)">
        ${FILTER_FIELDS.map(opt =>
          `<option value="${opt}"${f.field === opt ? ' selected' : ''}>${opt}</option>`
        ).join('')}
      </select>
      <select onchange="updateFilter(${f.id}, 'op', this.value)">
        ${FILTER_OPS.map(op =>
          `<option value="${op.value}"${f.op === op.value ? ' selected' : ''}>${op.label}</option>`
        ).join('')}
      </select>
      <input type="text" value="${escapeAttr(f.value)}"
             oninput="updateFilter(${f.id}, 'value', this.value)"
             placeholder="value" />
      <button class="filter-remove" onclick="removeFilter(${f.id})">×</button>
    </div>
  `).join('');
}

function buildFilters() {
  const filters = {};
  queryFilters.forEach(f => {
    if (f.value.trim()) {
      const key = f.op === 'eq' ? f.field : `${f.field}__${f.op}`;
      filters[key] = f.value.trim();
    }
  });
  return filters;
}

function updateQuerySnippet() {
  const pre = document.getElementById('query-snippet-pre');
  const lines = ['TraceLog("data/traces/traces.jsonl")'];
  queryFilters.forEach(f => {
    if (f.value.trim()) {
      const key = f.op === 'eq' ? f.field : `${f.field}__${f.op}`;
      lines.push(`    .filter(${key}="${f.value.trim()}")`);
    }
  });
  lines.push('    .last(20)');
  pre.textContent = lines.join('\n');
}

async function runQuery() {
  const filters = buildFilters();
  try {
    const res = await fetch('/api/tracelog/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters, limit: 20 }),
    });
    const traces = await res.json();
    queryHasRun = true;
    renderQueryResults(traces);
  } catch (err) {
    setStatus(`Query error: ${err.message}`);
  }
}

async function openQueryInViewer() {
  const filters = buildFilters();
  try {
    const res = await fetch('/api/tracelog/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters }),
    });
    const { url } = await res.json();
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    setStatus(`Could not open viewer: ${err.message}`);
  }
}

function renderQueryResults(traces) {
  const area  = document.getElementById('query-results-area');
  const noRun = document.getElementById('query-not-run');
  const count = document.getElementById('query-results-count');
  const table = document.getElementById('query-results-table');

  noRun.style.display = 'none';
  area.style.display  = 'block';

  const n = traces.length;
  count.textContent = `${n} trace${n !== 1 ? 's' : ''} matched.`;

  if (n === 0) {
    table.innerHTML = `<div class="query-empty">No traces matched.</div>`;
    return;
  }

  let html = `
    <table class="mini-table">
      <thead><tr>
        <th>Time</th><th>Action</th><th>Kind</th><th>Status</th><th>Duration</th>
      </tr></thead>
      <tbody>
  `;
  for (const t of traces) {
    const dur = t.duration_ms != null ? `${t.duration_ms.toFixed(1)} ms` : '—';
    html += `
      <tr>
        <td class="mono dim">${formatTime(t.started_at)}</td>
        <td class="mono bold">${escapeHtml(t.action || '—')}</td>
        <td><span class="badge badge-${escapeHtml(t.kind || 'app')}">${escapeHtml(t.kind || '—')}</span></td>
        <td>${makeStatusBadge(t.status)}</td>
        <td class="mono">${dur}</td>
      </tr>
    `;
  }
  html += `</tbody></table>`;
  table.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Sidebar search filter
// ---------------------------------------------------------------------------

function filterActions(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#sidebar-actions .action-card').forEach(card => {
    const label = (card.dataset.label || '').toLowerCase();
    card.style.display = (!q || label.includes(q)) ? '' : 'none';
  });
}

// ---------------------------------------------------------------------------
// Column drag-to-resize
// ---------------------------------------------------------------------------

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
      ? Math.max(180, Math.min(440, startW - delta))
      : Math.max(160, Math.min(460, startW + delta));
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
  makeDragResizer('drag-handle',       'sidebar',     false);
  makeDragResizer('drag-handle-right', 'detail-pane', true);
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

function syntaxHighlight(obj) {
  const escaped = JSON.stringify(obj, null, 2)
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
// Init
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  loadTraces();
  initSidebarDrag();
  wireMapZoom();
});
