// src/renderer.js  — läuft im Renderer-Process (kein Node-Zugriff)
'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const State = {
  connected: false,
  requests:  [],          // alle Network-Requests
  scripts:   new Map(),   // scriptId → { url, scriptId }
  breakpoints: new Map(), // breakpointId → { scriptId, lineNumber, elemRef }
  watches:   [],          // [{ expr, objectId? }]
  paused:    false,
  pausedFrames: [],
  selectedFrame: 0,
  selectedScriptId: null,
  selectedRequestId: null,
  consoleEntries: [],
};

// Wheel-Events ohne scrollbaren Vorfahren abfangen — verhindert den
// Electron/Chromium Compositor-Bug (schwarzer Bildschirm nach Mausrad-Scroll).
document.addEventListener('wheel', (e) => {
  let el = e.target;
  while (el && el !== document.documentElement) {
    const ov = window.getComputedStyle(el).overflowY;
    if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) return;
    el = el.parentElement;
  }
  e.preventDefault();
}, { passive: false });

// ── Copy-Utilities ────────────────────────────────────────────────────────────
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'),
      { value: text, style: 'position:fixed;opacity:0;top:0;left:0' });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  showCopyToast();
}
function showCopyToast() {
  const t = document.getElementById('copy-toast');
  if (!t) return;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 1400);
}

// Hilfsfunktion: kv-Tabellenzeile mit Click-to-Copy am Wert
function kvRow(label, html, rawCopy) {
  const cp = rawCopy !== undefined ? String(rawCopy) : html.replace(/<[^>]*>/g, '');
  return `<tr><td class="kv-key">${escHtml(label)}</td><td class="kv-val" data-copy="${escHtml(cp)}">${html}</td></tr>`;
}
function bodySection(label, bodyHtml) {
  return `<div class="body-section">
    <div class="section-hdr"><b>${label}</b><button class="copy-block-btn">⎘ Kopieren</button></div>
    ${bodyHtml}
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(bytes) {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(2) + ' MB';
}
function fmtMs(ms) {
  if (ms === undefined || ms === null) return '—';
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms/1000).toFixed(2) + ' s';
}
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function typeTag(type) {
  const m = { image:'img', script:'js', stylesheet:'css', font:'font', document:'doc', xhr:'xhr', fetch:'xhr', websocket:'ws', eventsource:'sse' };
  const k = m[type] || 'other';
  const label = { img:'IMG', js:'JS', css:'CSS', font:'FONT', doc:'DOC', xhr:'XHR', ws:'WS', sse:'SSE', other:'OTHER' }[k];
  return `<span class="tag ${k}">${label}</span>`;
}
function statusClass(s) {
  if (!s) return '';
  if (s >= 200 && s < 300) return 'ok200';
  if (s >= 300 && s < 400) return 'ok3xx';
  if (s >= 400 && s < 500) return 'err4xx';
  return 'err5xx';
}
function resourceType(mimeType, type) {
  if (!mimeType) return type || 'other';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('javascript') || mimeType.includes('ecmascript')) return 'script';
  if (mimeType.includes('css')) return 'stylesheet';
  if (mimeType.startsWith('font/') || mimeType.includes('woff')) return 'font';
  if (mimeType.includes('html') || mimeType.includes('xml')) return 'document';
  if (mimeType.includes('json') || mimeType.includes('form')) return 'xhr';
  return type || 'other';
}
function shortUrl(url) {
  try { const u = new URL(url); return u.pathname + (u.search ? '?' + u.search.slice(1,30) : ''); }
  catch { return url.slice(0, 80); }
}
function filename(url) {
  try { return new URL(url).pathname.split('/').pop() || url; }
  catch { return url.split('/').pop() || url; }
}
function syntaxHL(code) {
  return code
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/(\/\/[^\n]*)/g,'<span class="hl-cmt">$1</span>')
    .replace(/(\/\*[\s\S]*?\*\/)/g,'<span class="hl-cmt">$1</span>')
    .replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g,'<span class="hl-str">$1</span>')
    .replace(/\b(function|return|const|let|var|if|else|for|while|class|extends|new|this|async|await|import|export|from|default|try|catch|throw|typeof|instanceof|of|in|switch|case|break|continue|null|undefined|true|false|void|delete|yield)\b/g,'<span class="hl-kw">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g,'<span class="hl-num">$1</span>');
}
function renderRemoteObject(obj, depth = 0) {
  if (!obj) return '<span class="val-null">undefined</span>';
  const { type, subtype, value, description, preview } = obj;
  if (type === 'string')  return `<span class="val-string">"${escHtml(value)}"</span>`;
  if (type === 'number')  return `<span class="val-number">${value}</span>`;
  if (type === 'boolean') return `<span class="val-boolean">${value}</span>`;
  if (type === 'undefined' || subtype === 'null') return `<span class="val-null">${description || 'null'}</span>`;
  if (type === 'object' || type === 'function') {
    const desc = escHtml(description || (type === 'function' ? 'ƒ' : 'Object'));
    return `<span class="val-obj">${desc}</span>`;
  }
  return `<span class="val-null">${escHtml(String(value ?? description ?? type))}</span>`;
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Connection ────────────────────────────────────────────────────────────────
const dot = document.getElementById('conn-dot');
const statusText = document.getElementById('status-text');
const targetSelect = document.getElementById('target-select');

document.getElementById('btn-refresh').addEventListener('click', loadTargets);
document.getElementById('btn-connect').addEventListener('click', connect);
document.getElementById('btn-clear').addEventListener('click', clearAll);

async function loadTargets() {
  const res = await window.cdp.getTargets();
  targetSelect.innerHTML = '';
  if (!res.ok || !res.targets?.length) {
    targetSelect.innerHTML = '<option>Kein Chrome auf Port 9222 gefunden</option>';
    return;
  }
  res.targets.filter(t => t.type === 'page').forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.webSocketDebuggerUrl;
    opt.textContent = `[${t.type}] ${t.title || t.url}`.slice(0, 80);
    targetSelect.appendChild(opt);
  });
}

async function connect() {
  const url = targetSelect.value;
  if (!url) return;
  const res = await window.cdp.connect(url);
  if (!res.ok) { statusText.textContent = 'Fehler: ' + res.error; dot.className = 'dot err'; }
}

window.cdp.on('cdp:status', (data) => {
  State.connected = data.connected;
  dot.className = 'dot' + (data.connected ? ' ok' : '');
  statusText.textContent = data.connected
    ? 'Verbunden · ' + (data.url || '').split('/').pop()
    : 'Getrennt';
  if (data.connected) loadTargets();
});
window.cdp.on('cdp:error', (msg) => {
  statusText.textContent = 'Fehler: ' + msg;
  dot.className = 'dot err';
});

// Pause on exceptions toggle
document.getElementById('chk-pause-exceptions').addEventListener('change', async (e) => {
  await window.cdp.send('Debugger.setPauseOnExceptions', { state: e.target.checked ? 'all' : 'none' });
});

function clearAll() {
  State.requests = [];
  State.consoleEntries = [];
  renderNetworkTable();
  renderAssetTable();
  if (typeof renderApiTable === 'function') renderApiTable();
  document.getElementById('console-out').innerHTML = '';
  updateBadge('net', 0);
  updateBadge('assets', 0);
  updateBadge('console', 0);
  updateNetStats();
}

function updateBadge(id, n) {
  const el = document.getElementById('badge-' + id);
  if (el) el.textContent = n;
}

// ── NETWORK PANEL ─────────────────────────────────────────────────────────────
const netRequests = new Map(); // requestId → partial request data

window.cdp.on('cdp:network', ({ method, params, sessionId }) => {
  if (method === 'Network.requestWillBeSent') {
    netRequests.set(params.requestId, {
      id: params.requestId,
      method: params.request.method,
      url: params.request.url,
      headers: params.request.headers,
      postData: params.request.postData,
      initiatorType: params.initiator?.type,
      initiatorUrl: params.initiator?.url || params.initiator?.stack?.callFrames?.[0]?.url,
      ts: params.timestamp,
      source: sessionId ? 'worker' : (params.type === 'Ping' ? 'beacon' : null),
      status: null, mime: null, size: null, protocol: null, responseHeaders: null,
    });
  }

  // ── WebSocket: eigene Events, im Standard-Panel sonst nicht erfasst ─────────
  if (method === 'Network.webSocketCreated') {
    pushHidden({ id: 'ws-' + params.requestId, method: 'WS', url: params.url,
      type: 'websocket', source: sessionId ? 'worker' : 'websocket', status: 101 });
  }
  if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
    const dir = method.endsWith('Sent') ? '↑' : '↓';
    const ws = State.requests.find(r => r.id === 'ws-' + params.requestId);
    pushHidden({ id: 'wsf-' + params.requestId + '-' + Math.random().toString(36).slice(2,7),
      method: 'WS' + dir, url: (ws && ws.url) || 'websocket',
      type: 'websocket', source: 'websocket', status: 101,
      postData: (params.response && params.response.payloadData || '').slice(0, 2000) });
  }
  // ── Server-Sent Events ─────────────────────────────────────────────────────
  if (method === 'Network.eventSourceMessageReceived') {
    pushHidden({ id: 'sse-' + params.requestId + '-' + (params.eventId || Math.random().toString(36).slice(2,7)),
      method: 'SSE', url: params.eventName || 'event-stream',
      type: 'eventsource', source: 'sse', status: 200,
      postData: (params.data || '').slice(0, 2000) });
  }
  if (method === 'Network.responseReceived') {
    const r = netRequests.get(params.requestId);
    if (r) {
      r.status = params.response.status;
      r.statusText = params.response.statusText;
      r.mime = params.response.mimeType;
      r.protocol = params.response.protocol;
      r.responseHeaders = params.response.headers;
      r.remoteAddress = params.response.remoteIPAddress;
      r.type = resourceType(r.mime, params.type?.toLowerCase());
      if (params.response.timing) {
        r.timing = params.response.timing;
      }
    }
  }
  if (method === 'Network.loadingFinished') {
    const r = netRequests.get(params.requestId);
    if (r) {
      r.size = params.encodedDataLength;
      r.timeMs = params.timestamp && r.ts ? (params.timestamp - r.ts) * 1000 : null;
      // Zu State pushen, wenn noch nicht da
      if (!State.requests.find(x => x.id === r.id)) {
        State.requests.push({ ...r });
        renderNetworkTable();
        renderAssetTable();
        renderApiTable();
        updateNetStats();
      }
    }
  }
  if (method === 'Network.loadingFailed') {
    const r = netRequests.get(params.requestId);
    if (r) {
      r.failed = true;
      r.errorText = params.errorText;
      r.status = r.status || 0;
      if (!State.requests.find(x => x.id === r.id)) {
        State.requests.push({ ...r });
        renderNetworkTable();
        renderApiTable();
        updateNetStats();
      }
    }
  }
});

// ── Versteckte Calls (Worker-Intercept, Monkey-Patch-Hooks, WS/SSE) ──────────
// Quelle → Farbe/Label für die Source-Badge in der Network-Tabelle
const SOURCE_META = {
  worker:     { label: 'WORKER',  color: '#d29922' },
  beacon:     { label: 'BEACON',  color: '#f85149' },
  websocket:  { label: 'WS',      color: '#3fb950' },
  sse:        { label: 'SSE',     color: '#58a6ff' },
  intercept:  { label: 'FETCH',   color: '#bc8cff' },
  hook:       { label: 'HOOK',    color: '#bc8cff' },
  fetch:      { label: 'HOOK',    color: '#bc8cff' },
  xhr:        { label: 'HOOK',    color: '#bc8cff' },
  eventsource:{ label: 'HOOK',    color: '#58a6ff' },
};

function sourceBadge(src) {
  if (!src) return '';
  const m = SOURCE_META[src] || { label: String(src).toUpperCase(), color: '#8b949e' };
  return `<span style="display:inline-block;font-size:9px;font-weight:600;padding:0 4px;margin-right:5px;border-radius:3px;color:#0d1117;background:${m.color}">${m.label}</span>`;
}

function pushHidden(r) {
  if (State.requests.find(x => x.id === r.id)) return;
  State.requests.push({ headers: {}, responseHeaders: {}, hidden: true, ...r });
  renderNetworkTable();
  renderApiTable();
  updateNetStats();
}

window.cdp.on('cdp:hidden', ({ source, data }) => {
  if (!data) return;
  // Worker/Target-Attach-Hinweis
  if (source === 'target') {
    console.info('[CDP] Sub-Target attached:', data.type, data.url);
    return;
  }
  const id = (data.requestId || (source + '-' + (data.url || '') + '-' + Date.now()))
    + '-' + Math.random().toString(36).slice(2, 7);
  pushHidden({
    id,
    method: data.method || 'GET',
    url: data.url || '(unbekannt)',
    postData: data.body || data.postData || null,
    headers: data.headers || {},
    source: source,
    type: data.resourceType ? data.resourceType.toLowerCase() : 'xhr',
    status: null,
  });
});

// ── Deep Intercept Toggle ────────────────────────────────────────────────────
document.getElementById('chk-deep-intercept')?.addEventListener('change', async (e) => {
  if (!State.connected) { e.target.checked = false; return; }
  const res = await window.cdp.deepIntercept(e.target.checked);
  const lbl = document.getElementById('deep-intercept-label');
  if (lbl) lbl.style.color = (res.ok && res.enabled) ? 'var(--purple, #bc8cff)' : 'var(--text1)';
});

// Filter-Inputs
['net-filter','net-type-filter','chk-errors-only'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', renderNetworkTable);
  document.getElementById(id)?.addEventListener('change', renderNetworkTable);
});

function getFilteredRequests() {
  const text = document.getElementById('net-filter').value.toLowerCase();
  const type = document.getElementById('net-type-filter').value;
  const errOnly = document.getElementById('chk-errors-only').checked;
  return State.requests.filter(r => {
    if (text && !r.url.toLowerCase().includes(text) && !(r.type || '').includes(text)) return false;
    if (type && r.type !== type) return false;
    if (errOnly && r.status >= 200 && r.status < 400 && !r.failed) return false;
    return true;
  });
}

function renderNetworkTable() {
  const rows = getFilteredRequests();
  const tbody = document.getElementById('net-tbody');
  const empty = document.getElementById('net-empty');
  document.getElementById('req-count').textContent = rows.length;
  updateBadge('net', State.requests.length);

  if (!rows.length) { tbody.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  tbody.innerHTML = rows.map((r, i) => {
    const sc = r.failed ? 'err4xx' : statusClass(r.status);
    return `<tr data-id="${escHtml(r.id)}" class="${State.selectedRequestId === r.id ? 'selected' : ''}">
      <td class="mono num">${i+1}</td>
      <td class="mono" style="color:var(--cyan)">${escHtml(r.method||'GET')}</td>
      <td class="mono ${sc}">${r.failed ? 'ERR' : (r.status||'—')}</td>
      <td>${typeTag(r.type || 'other')}</td>
      <td class="mono" title="${escHtml(r.url)}">${sourceBadge(r.source)}${escHtml(shortUrl(r.url))}<button class="row-copy-btn" data-copy="${escHtml(r.url)}" title="URL kopieren">⎘</button></td>
      <td class="mono num">${fmt(r.size)}</td>
      <td class="mono num">${fmtMs(r.timeMs)}</td>
      <td class="mono" style="color:var(--text1)">${escHtml(r.protocol||'')}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const req = State.requests.find(r => r.id === tr.dataset.id);
      if (req) showNetworkDetail(req);
    });
  });
}

async function showNetworkDetail(req) {
  State.selectedRequestId = req.id;
  renderNetworkTable();
  const pane = document.getElementById('net-detail');

  // Body laden
  let bodyHtml = '<i style="color:var(--text2)">Lade Body …</i>';
  pane.innerHTML = `
    <div class="detail-header"><strong>${escHtml(filename(req.url))}</strong></div>
    <div class="detail-tabs">
      <div class="dtab active" data-dtab="headers">Headers</div>
      <div class="dtab" data-dtab="body">Body</div>
      <div class="dtab" data-dtab="timing">Timing</div>
    </div>
    <div class="detail-body" id="dnet-content"></div>`;

  const content = pane.querySelector('#dnet-content');

  function showHeaders() {
    const reqH = Object.entries(req.headers||{}).map(([k,v]) => kvRow(k, escHtml(v))).join('');
    const resH = Object.entries(req.responseHeaders||{}).map(([k,v]) => kvRow(k, escHtml(v))).join('');
    const statusDisplay = req.failed
      ? `<span class="err4xx">FAILED ‒ ${escHtml(req.errorText||'')}</span>`
      : `<span class="${statusClass(req.status)}">${req.status} ${escHtml(req.statusText||'')}</span>`;
    content.innerHTML = `
      <table class="kv-table" style="margin-bottom:8px"><tr><td colspan=2><b style="color:var(--accent)">General</b></td></tr>
        ${kvRow('URL', escHtml(req.url))}
        ${kvRow('Methode', escHtml(req.method||''))}
        ${kvRow('Status', statusDisplay, req.failed ? 'FAILED' : String(req.status||''))}
        ${kvRow('Typ', escHtml(req.type||''))}
        ${kvRow('MIME', escHtml(req.mime||''))}
        ${kvRow('Protokoll', escHtml(req.protocol||''))}
        ${kvRow('Remote IP', escHtml(req.remoteAddress||''))}
        ${kvRow('Initiator', escHtml(req.initiatorType||'') + (req.initiatorUrl ? ' · <span style="color:var(--text1)">'+escHtml(filename(req.initiatorUrl))+'</span>' : ''), req.initiatorType||'')}
        ${kvRow('Größe', fmt(req.size))}
        ${kvRow('Zeit', fmtMs(req.timeMs))}
      </table>
      ${reqH ? `<b style="color:var(--accent);font-size:11px">Request Headers</b><table class="kv-table" style="margin:6px 0">${reqH}</table>` : ''}
      ${resH ? `<b style="color:var(--accent);font-size:11px">Response Headers</b><table class="kv-table" style="margin:6px 0">${resH}</table>` : ''}
      ${req.postData ? bodySection('Post Data', `<pre style="margin-top:6px">${escHtml(req.postData)}</pre>`) : ''}`;
  }

  async function showBody() {
    content.innerHTML = '<i style="color:var(--text2)">Lade …</i>';
    const res = await window.cdp.getBody(req.id);
    if (!res.ok) { content.innerHTML = `<span style="color:var(--red)">${escHtml(res.error)}</span>`; return; }
    const { body, base64Encoded } = res.result;
    if (base64Encoded) {
      content.innerHTML = bodySection('Response Body (Base64)',
        `<i style="color:var(--text1)">Base64-kodiert (${fmt(body?.length||0)} Zeichen)</i><br><pre style="max-height:400px;overflow:auto">${escHtml((body||'').slice(0,2000))}</pre>`);
    } else {
      let pretty = body || '';
      try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch {}
      content.innerHTML = bodySection('Response Body', `<pre>${syntaxHL(pretty.slice(0,8000))}</pre>`);
    }
  }

  function showTiming() {
    if (!req.timing) { content.innerHTML = '<i style="color:var(--text2)">Keine Timing-Daten</i>'; return; }
    const t = req.timing;
    const fields = ['dnsStart','dnsEnd','connectStart','connectEnd','sslStart','sslEnd','sendStart','sendEnd','receiveHeadersEnd'];
    content.innerHTML = '<table class="kv-table">' +
      fields.filter(f => t[f] !== undefined && t[f] >= 0).map(f =>
        `<tr><td>${f}</td><td class="num mono">${t[f].toFixed(2)} ms</td></tr>`
      ).join('') + '</table>';
  }

  showHeaders();
  pane.querySelectorAll('.dtab').forEach(dt => {
    dt.addEventListener('click', () => {
      pane.querySelectorAll('.dtab').forEach(d => d.classList.remove('active'));
      dt.classList.add('active');
      if (dt.dataset.dtab === 'headers') showHeaders();
      else if (dt.dataset.dtab === 'body') showBody();
      else showTiming();
    });
  });
}

function updateNetStats() {
  const r = State.requests;
  document.getElementById('stat-total').textContent = r.length;
  document.getElementById('stat-img').textContent   = r.filter(x => x.type === 'image').length;
  document.getElementById('stat-js').textContent    = r.filter(x => x.type === 'script').length;
  document.getElementById('stat-xhr').textContent   = r.filter(x => x.type === 'xhr').length;
  document.getElementById('stat-err').textContent   = r.filter(x => x.failed || x.status >= 400).length;
  const total = r.reduce((s, x) => s + (x.size || 0), 0);
  document.getElementById('stat-size').textContent  = fmt(total);
}

// ── ASSETS PANEL ──────────────────────────────────────────────────────────────
document.getElementById('asset-filter').addEventListener('input', renderAssetTable);

function renderAssetTable() {
  const text = document.getElementById('asset-filter').value.toLowerCase();
  const assets = State.requests.filter(r =>
    ['image','script','stylesheet','font','document'].includes(r.type) &&
    (!text || r.url.toLowerCase().includes(text))
  );
  const tbody = document.getElementById('asset-tbody');
  const empty = document.getElementById('asset-empty');
  document.getElementById('asset-count').textContent = assets.length;
  updateBadge('assets', assets.length);

  if (!assets.length) { tbody.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  tbody.innerHTML = assets.map(r => `
    <tr data-id="${escHtml(r.id)}">
      <td>${typeTag(r.type)}</td>
      <td class="mono" title="${escHtml(r.url)}">${escHtml(filename(r.url))}</td>
      <td class="mono" style="color:var(--text1)" title="${escHtml(r.url)}">${escHtml(shortUrl(r.url))}</td>
      <td class="mono num">${fmt(r.size)}</td>
      <td style="color:var(--text1);font-size:11px">${escHtml((r.mime||'').split(';')[0])}</td>
      <td style="color:var(--text1)">${r.fromCache ? '✓' : ''}</td>
      <td style="color:var(--text1)">${escHtml(r.initiatorType||'')}</td>
    </tr>`).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const req = State.requests.find(r => r.id === tr.dataset.id);
      if (req) showAssetDetail(req);
    });
  });
}

async function showAssetDetail(req) {
  const pane = document.getElementById('asset-detail');
  pane.innerHTML = `
    <div class="detail-header">${typeTag(req.type)} <strong>${escHtml(filename(req.url))}</strong></div>
    <div class="detail-tabs">
      <div class="dtab active" data-dtab="info">Info</div>
      <div class="dtab" data-dtab="preview">Vorschau</div>
    </div>
    <div class="detail-body" id="dasset-content"></div>`;
  const content = pane.querySelector('#dasset-content');

  function showInfo() {
    content.innerHTML = `<table class="kv-table">
      <tr><td>URL</td><td><a href="#" onclick="window.cdp.openExternal('${escHtml(req.url)}')">${escHtml(req.url)}</a></td></tr>
      <tr><td>Typ</td><td>${escHtml(req.type)}</td></tr>
      <tr><td>MIME</td><td>${escHtml(req.mime||'')}</td></tr>
      <tr><td>Größe</td><td>${fmt(req.size)}</td></tr>
      <tr><td>Protokoll</td><td>${escHtml(req.protocol||'')}</td></tr>
      <tr><td>Initiator</td><td>${escHtml(req.initiatorType||'')}${req.initiatorUrl?' — '+escHtml(filename(req.initiatorUrl)):''}</td></tr>
      <tr><td>Status</td><td class="${statusClass(req.status)}">${req.status||'—'}</td></tr>
      <tr><td>Zeit</td><td>${fmtMs(req.timeMs)}</td></tr>
    </table>`;
  }

  async function showPreview() {
    content.innerHTML = '<i style="color:var(--text2)">Lade …</i>';
    const res = await window.cdp.getBody(req.id);
    if (!res.ok) { content.innerHTML = `<span style="color:var(--red)">${escHtml(res.error)}</span>`; return; }
    const { body, base64Encoded } = res.result;

    if (req.type === 'image') {
      const src = base64Encoded ? `data:${req.mime};base64,${body}` : req.url;
      content.innerHTML = `<img src="${src}" style="max-width:100%;max-height:300px;display:block;margin-bottom:8px">`;
    } else {
      let code = body || '';
      try { code = JSON.stringify(JSON.parse(code), null, 2); } catch {}
      content.innerHTML = `<pre style="max-height:500px;overflow:auto">${syntaxHL(code.slice(0,10000))}</pre>`;
    }
  }

  showInfo();
  pane.querySelectorAll('.dtab').forEach(dt => {
    dt.addEventListener('click', () => {
      pane.querySelectorAll('.dtab').forEach(d => d.classList.remove('active'));
      dt.classList.add('active');
      if (dt.dataset.dtab === 'info') showInfo();
      else showPreview();
    });
  });
}

// ── DEBUGGER PANEL ────────────────────────────────────────────────────────────
const App = { dbg: {}, console: {}, api: {} };

window.cdp.on('cdp:debugger', ({ method, params }) => {
  if (method === 'Debugger.scriptParsed') {
    const url = params.url || params.sourceURL || '(anon)';
    State.scripts.set(params.scriptId, { scriptId: params.scriptId, url });
    renderScriptList();
    document.getElementById('script-count').textContent = State.scripts.size;
  }
  if (method === 'Debugger.paused') {
    State.paused = true;
    State.pausedFrames = params.callFrames || [];
    State.selectedFrame = 0;
    showPausedState(params);
  }
  if (method === 'Debugger.resumed') {
    State.paused = false;
    State.pausedFrames = [];
    document.getElementById('paused-bar').classList.remove('show');
    document.getElementById('scope-body').innerHTML = '';
    document.getElementById('callstack-body').innerHTML = '';
  }
});

document.getElementById('script-filter').addEventListener('input', renderScriptList);

function renderScriptList() {
  const text = document.getElementById('script-filter').value.toLowerCase();
  const list = document.getElementById('script-list');
  list.innerHTML = '';
  State.scripts.forEach(({ scriptId, url }) => {
    if (text && !url.toLowerCase().includes(text)) return;
    const div = document.createElement('div');
    div.className = 'script-item' + (State.selectedScriptId === scriptId ? ' selected' : '');
    div.title = url;
    div.textContent = filename(url) || scriptId;
    div.addEventListener('click', () => loadScript(scriptId, url));
    list.appendChild(div);
  });
}

async function loadScript(scriptId, url) {
  State.selectedScriptId = scriptId;
  renderScriptList();
  document.getElementById('src-filename').textContent = url || scriptId;

  const res = await window.cdp.getScriptSource(scriptId);
  if (!res.ok) { return; }
  renderSource(res.result.scriptSource, scriptId);
}

function renderSource(code, scriptId) {
  const lines = code.split('\n');
  const wrap = document.getElementById('source-wrap');

  const numsDiv = document.createElement('div');
  numsDiv.className = 'line-nums';
  const codeDiv = document.createElement('div');
  codeDiv.className = 'source-code';

  numsDiv.innerHTML = lines.map((_, i) => {
    const ln = i + 1;
    const hasBp = [...State.breakpoints.values()].some(b => b.scriptId === scriptId && b.lineNumber === i);
    return `<div class="lnum${hasBp?' bp':''}" data-line="${i}" data-scriptid="${escHtml(scriptId)}">${ln}</div>`;
  }).join('');

  codeDiv.innerHTML = syntaxHL(code);

  wrap.innerHTML = '';
  wrap.appendChild(numsDiv);
  wrap.appendChild(codeDiv);

  // Breakpoint click
  numsDiv.querySelectorAll('.lnum').forEach(el => {
    el.addEventListener('click', () => toggleBreakpoint(el.dataset.scriptid, parseInt(el.dataset.line), el));
  });
}

async function toggleBreakpoint(scriptId, lineNumber, el) {
  // Prüfen ob schon gesetzt
  for (const [bpId, bp] of State.breakpoints) {
    if (bp.scriptId === scriptId && bp.lineNumber === lineNumber) {
      await window.cdp.removeBreakpoint(bpId);
      State.breakpoints.delete(bpId);
      el.classList.remove('bp');
      updateBadge('bp', State.breakpoints.size);
      return;
    }
  }
  const res = await window.cdp.setBreakpoint({ scriptId, lineNumber });
  if (res.ok) {
    const bpId = res.result.breakpointId;
    State.breakpoints.set(bpId, { scriptId, lineNumber, elem: el });
    el.classList.add('bp');
    updateBadge('bp', State.breakpoints.size);
  }
}

async function showPausedState(params) {
  const bar = document.getElementById('paused-bar');
  bar.classList.add('show');
  const reason = params.reason || '';
  document.getElementById('paused-reason').textContent =
    reason === 'exception' ? '⚠ Exception: ' + (params.data?.description || '') : reason;

  // Call stack
  const csBody = document.getElementById('callstack-body');
  csBody.innerHTML = State.pausedFrames.map((f, i) => `
    <div class="callframe-item${i===0?' selected':''}" data-frame="${i}">
      <div class="callframe-fn">${escHtml(f.functionName || '(anon)')}</div>
      <div class="callframe-loc">${escHtml(filename(f.url||''))}:${f.location?.lineNumber??''}</div>
    </div>`).join('');

  csBody.querySelectorAll('.callframe-item').forEach(el => {
    el.addEventListener('click', async () => {
      csBody.querySelectorAll('.callframe-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      State.selectedFrame = parseInt(el.dataset.frame);
      await showScopeForFrame(State.selectedFrame);
      await refreshWatches();
    });
  });

  // Zum pausierten Script springen
  const frame = State.pausedFrames[0];
  if (frame?.location) {
    const { scriptId, lineNumber } = frame.location;
    if (State.selectedScriptId !== scriptId) {
      const s = State.scripts.get(scriptId);
      if (s) await loadScript(scriptId, s.url);
    }
    // Zeile hervorheben
    const numsDiv = document.querySelector('.line-nums');
    if (numsDiv) {
      numsDiv.querySelectorAll('.lnum').forEach(el => el.classList.remove('paused'));
      const target = numsDiv.querySelector(`.lnum[data-line="${lineNumber}"]`);
      if (target) { target.classList.add('paused'); target.scrollIntoView({ block: 'center' }); }
    }
  }

  await showScopeForFrame(0);
  await refreshWatches();
}

async function showScopeForFrame(frameIdx) {
  const frame = State.pausedFrames[frameIdx];
  if (!frame) return;
  const body = document.getElementById('scope-body');
  body.innerHTML = '';

  for (const scope of (frame.scopeChain || [])) {
    const header = document.createElement('div');
    header.style.cssText = 'color:var(--text1);font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:4px 0 2px;font-weight:600;';
    header.textContent = scope.type;
    body.appendChild(header);

    if (!scope.object?.objectId) continue;
    const res = await window.cdp.getProperties(scope.object.objectId, true);
    if (!res.ok) continue;

    (res.result.result || []).slice(0, 50).forEach(prop => {
      if (!prop.enumerable && prop.name.startsWith('__')) return;
      const div = document.createElement('div');
      div.className = 'scope-item';
      div.innerHTML = `<span class="scope-key">${escHtml(prop.name)}</span>: ${renderRemoteObject(prop.value)}`;
      body.appendChild(div);
    });
  }
}

// Step controls
App.dbg.step = async (action) => {
  await window.cdp.step(action);
};

// Watch
App.dbg.addWatch = async () => {
  const input = document.getElementById('watch-input');
  const expr = input.value.trim();
  if (!expr) return;
  State.watches.push({ expr });
  input.value = '';
  await refreshWatches();
};

App.dbg.toggleSection = () => {};

async function refreshWatches() {
  const list = document.getElementById('watch-list');
  list.innerHTML = '';
  const frameId = State.paused && State.pausedFrames[State.selectedFrame]?.callFrameId;

  for (let i = 0; i < State.watches.length; i++) {
    const w = State.watches[i];
    let valHtml = '<span class="watch-val" style="color:var(--text2)">—</span>';
    if (State.paused || !frameId) {
      const res = await window.cdp.evaluate(w.expr, frameId || null);
      if (res.ok) {
        const obj = res.result.result || res.result.exceptionDetails;
        valHtml = `<span class="watch-val">${renderRemoteObject(obj)}</span>`;
      } else {
        valHtml = `<span class="watch-val err">${escHtml(res.error)}</span>`;
      }
    }

    const div = document.createElement('div');
    div.className = 'watch-item';
    div.innerHTML = `
      <span class="watch-expr">${escHtml(w.expr)}</span>
      ${valHtml}
      <span class="watch-remove" data-i="${i}" title="Entfernen">✕</span>`;
    list.appendChild(div);
  }

  list.querySelectorAll('.watch-remove').forEach(el => {
    el.addEventListener('click', () => {
      State.watches.splice(parseInt(el.dataset.i), 1);
      refreshWatches();
    });
  });
}

// "Watch" Button in der Source-Toolbar
document.getElementById('btn-add-watch-from-src').addEventListener('click', () => {
  const expr = window.getSelection()?.toString().trim();
  if (expr) {
    State.watches.push({ expr });
    refreshWatches();
    // Zum Debugger-Tab wechseln
    document.querySelector('[data-tab="debugger"]').click();
  }
});

// Source-Suche
document.getElementById('src-search').addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase();
  const code = document.querySelector('.source-code');
  if (!code || !term) return;
  // Einfaches Highlight: nur Scroll zur ersten Fundstelle
  const text = code.textContent;
  const idx = text.toLowerCase().indexOf(term);
  if (idx >= 0) {
    const lineN = text.slice(0, idx).split('\n').length;
    const lnum = document.querySelector(`.lnum[data-line="${lineN-1}"]`);
    if (lnum) lnum.scrollIntoView({ block: 'center' });
  }
});

// ── CONSOLE PANEL ─────────────────────────────────────────────────────────────
window.cdp.on('cdp:runtime', ({ method, params }) => {
  if (method !== 'Runtime.consoleAPICalled') return;
  const entry = {
    type: params.type || 'log',
    args: params.args || [],
    ts: params.timestamp,
  };
  State.consoleEntries.push(entry);
  appendConsoleEntry(entry);
  updateBadge('console', State.consoleEntries.length);
  document.getElementById('console-count').textContent = State.consoleEntries.length;
});

function appendConsoleEntry(entry) {
  const showLog   = document.getElementById('chk-console-log').checked;
  const showWarn  = document.getElementById('chk-console-warn').checked;
  const showError = document.getElementById('chk-console-error').checked;
  const t = entry.type;
  if (t === 'log' && !showLog) return;
  if (t === 'warning' && !showWarn) return;
  if ((t === 'error' || t === 'assert') && !showError) return;

  const out = document.getElementById('console-out');
  const div = document.createElement('div');
  div.className = `console-entry ${t === 'warning' ? 'warn' : t === 'error' || t === 'assert' ? 'err' : t === 'info' ? 'info' : 'log'}`;
  const text = entry.args.map(a => {
    if (a.type === 'string') return a.value;
    if (a.type === 'number' || a.type === 'boolean') return String(a.value);
    return a.description || a.type;
  }).join(' ');
  div.textContent = text;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

App.console.clear = () => {
  State.consoleEntries = [];
  document.getElementById('console-out').innerHTML = '';
  document.getElementById('console-count').textContent = 0;
  updateBadge('console', 0);
};

App.console.run = async () => {
  const input = document.getElementById('console-input');
  const expr = input.value.trim();
  if (!expr) return;
  input.value = '';

  // Eingabe anzeigen
  const out = document.getElementById('console-out');
  const inputDiv = document.createElement('div');
  inputDiv.className = 'console-entry';
  inputDiv.style.color = 'var(--accent)';
  inputDiv.textContent = '>> ' + expr;
  out.appendChild(inputDiv);

  const frameId = State.paused && State.pausedFrames[State.selectedFrame]?.callFrameId;
  const res = await window.cdp.evaluate(expr, frameId || null);

  const resultDiv = document.createElement('div');
  resultDiv.className = 'console-entry';
  if (res.ok) {
    const obj = res.result.result || res.result.exceptionDetails?.exception;
    resultDiv.innerHTML = '<← ' + renderRemoteObject(obj);
    if (res.result.exceptionDetails) resultDiv.className += ' err';
  } else {
    resultDiv.className += ' err';
    resultDiv.textContent = '← Error: ' + res.error;
  }
  out.appendChild(resultDiv);
  out.scrollTop = out.scrollHeight;
};

document.getElementById('console-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') App.console.run();
});
document.getElementById('watch-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') App.dbg.addWatch();
});

// Filter-Checkboxen für Console
['chk-console-log','chk-console-warn','chk-console-error'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    document.getElementById('console-out').innerHTML = '';
    State.consoleEntries.forEach(appendConsoleEntry);
  });
});

// ── API PANEL ─────────────────────────────────────────────────────────────────

// API-Pfad-Muster: häufige API-Segmente in der URL
// Pfad-Muster: v1/, v1.0/, /api/, /odata/, /intents/, /releases/, /collector/, …
const API_PATH_RE = /\/(?:api|rest|gql|graphql|v\d+(?:\.\d+)*|rpc|service|endpoint|query|data|feed|odata|intents|releases|policies|settings|admin|batch|health|reports?|metric|telemetry|collector|permissions?|graph|sync|deploy|config)\//i;
// Host-Muster: api., graph., config., portal., events., data., collector., …
const API_HOST_RE = /(?:api\.|apis\.|graph\.|platform\.|gateway\.|microservice\.|backend\.|config\.|portal\.|data\.|events\.|analytics\.|collector\.|management\.)/i;

function isApiRequest(r) {
  // 1. CDP ResourceType: 'xhr' / 'fetch' — sicherste Quelle
  if (r.type === 'xhr' || r.type === 'fetch') return true;

  // 2. Response-MIME deutet auf strukturierte Daten
  if (r.mime && (r.mime.includes('json') || r.mime.includes('graphql')
              || r.mime.includes('xml+api') || r.mime.includes('ld+json'))) return true;

  // 3. Request hat JSON-Body (unabhängig vom Ergebnis-Typ)
  const ct = (Object.entries(r.headers || {}).find(([k]) =>
    k.toLowerCase() === 'content-type')?.[1] || '').toLowerCase();
  if (ct.includes('application/json') || ct.includes('application/graphql')) return true;

  // 4. Request erwartet JSON-Antwort
  const accept = (Object.entries(r.headers || {}).find(([k]) =>
    k.toLowerCase() === 'accept')?.[1] || '').toLowerCase();
  if (accept.includes('application/json') || accept.includes('application/ld+json')) return true;

  // 5. Payload ist JSON (z.B. bei form-submit-POSTs die eigentlich JSON senden)
  if (r.postData) {
    const d = r.postData.trim();
    if (d.startsWith('{') || d.startsWith('[')) return true;
  }

  // 6. URL-Pfad enthält typische API-Segmente (/api/, /v1/, /graphql, …)
  if (r.url && API_PATH_RE.test(r.url)) return true;

  // 7. Subdomain-Muster (api.example.com, graph.example.com, …)
  try {
    if (API_HOST_RE.test(new URL(r.url).hostname)) return true;
  } catch {}

  return false;
}

function maskToken(s) {
  if (!s || s.length < 10) return escHtml(s || '');
  return `<span title="${escHtml(s)}">${escHtml(s.slice(0, 8))}…${escHtml(s.slice(-4))}</span>`;
}

function parseJwt(token) {
  try {
    const b64 = (s) => JSON.parse(atob(s.replace(/-/g,'+').replace(/_/g,'/')));
    const header  = b64(token.split('.')[0]);
    const payload = b64(token.split('.')[1]);
    return { header, payload };
  } catch { return null; }
}

function decodeJwtForDisplay(token) {
  const j = parseJwt(token);
  if (!j) return null;
  const { header, payload } = j;
  const now = Math.floor(Date.now() / 1000);

  const expired   = payload.exp && now > payload.exp;
  const expInMin  = payload.exp ? Math.round((payload.exp - now) / 60) : null;
  const isMsft    = /login\.microsoftonline|sts\.windows\.net/i.test(payload.iss || '');
  const scopes    = (payload.scp || payload.scope || '').split(/\s+/).filter(Boolean);
  const roles     = [].concat(payload.roles || []);
  const groups    = [].concat(payload.groups || []);

  const expBar = expired
    ? `<div class="jwt-bar expired">✗ Token ABGELAUFEN seit ${Math.abs(expInMin)} Min. — Request schlägt fehl!</div>`
    : expInMin !== null
      ? `<div class="jwt-bar ${expInMin < 5 ? 'warn' : 'valid'}">✓ Gültig noch ${expInMin} Min. · Ablauf: ${new Date(payload.exp*1000).toLocaleTimeString()}</div>`
      : '';

  const field = (k, v, mono) => v
    ? `<div class="jwt-field"><span class="jwt-key">${k}</span><span class="jwt-val${mono?' mono':''}">${v}</span></div>` : '';

  const chipRow = (label, chips, cls) => chips.length
    ? `<div class="jwt-perms"><span class="jwt-key">${label}</span><div class="jwt-chips">${chips.map(c=>`<span class="jwt-chip ${cls}">${escHtml(c)}</span>`).join('')}</div></div>` : '';

  const identity = [
    field('Name',          escHtml(payload.name || '')),
    field('UPN / Login',   escHtml(payload.upn || payload.preferred_username || payload.email || '')),
    field('Tenant-ID',     `<span class="mono">${escHtml(payload.tid||'')}</span>`),
    field('Object-ID',     `<span class="mono">${escHtml(payload.oid||'')}</span>`),
    field('Subject',       `<span class="mono" title="${escHtml(payload.sub||'')}">${escHtml((payload.sub||'').slice(0,40))}${(payload.sub||'').length>40?'…':''}</span>`),
  ].join('');

  const technical = [
    field('Audience (aud)',  escHtml(Array.isArray(payload.aud)?payload.aud.join(', '):String(payload.aud||''))),
    field('Issuer (iss)',    escHtml(payload.iss||'')),
    field('App-ID (appid)', `<span class="mono">${escHtml(payload.appid||payload.azp||'')}</span>`),
    field('App-Name',       escHtml(payload.app_displayname||'')),
    field('Version',        escHtml(payload.ver||'')),
    field('Algorithmus',    escHtml(`${header.alg||''} / ${header.typ||'JWT'}`)),
    field('Ausgestellt',    payload.iat ? new Date(payload.iat*1000).toLocaleString() : ''),
    field('Ablauf',         payload.exp ? new Date(payload.exp*1000).toLocaleString() : ''),
  ].join('');

  return `
    ${expBar}
    <div class="jwt-badges">${isMsft?'<span class="jwt-badge ms">Microsoft Entra ID</span>':''}<span class="jwt-badge ${expired?'expired':'valid'}">${expired?'ABGELAUFEN':'GÜLTIG'}</span></div>

    <div class="jwt-section-title">Identität</div>
    <div class="jwt-grid">${identity}</div>

    ${chipRow('Berechtigungen (Scopes)', scopes, 'scope')}
    ${chipRow('Rollen', roles, 'role')}
    ${groups.length ? `<div class="jwt-perms"><span class="jwt-key">Gruppen</span><span class="jwt-val" style="margin-left:6px">${groups.length} Gruppen im Token</span></div>` : ''}

    <div class="jwt-section-title" style="margin-top:10px">Technisch</div>
    <div class="jwt-grid">${technical}</div>

    <details style="margin-top:10px">
      <summary class="jwt-summary">{ } Vollständiger Payload (JSON)</summary>
      <div class="body-section">
        <div class="section-hdr"><b>JWT Payload</b><button class="copy-block-btn">⎘ Kopieren</button></div>
        <div class="json-pre" style="max-height:320px">${syntaxHL(escHtml(JSON.stringify(payload,null,2)))}</div>
      </div>
    </details>

    <details style="margin-top:6px">
      <summary class="jwt-summary">⚠ Roher Bearer Token (sensibel)</summary>
      <div class="body-section">
        <div class="section-hdr"><b>Token</b><button class="copy-block-btn">⎘ Kopieren</button></div>
        <pre style="word-break:break-all;font-size:10px;max-height:100px;overflow:auto">${escHtml(token)}</pre>
      </div>
    </details>`;
}

function detectAuth(req) {
  const h = Object.fromEntries(
    Object.entries(req.headers || {}).map(([k,v]) => [k.toLowerCase(), v])
  );
  const auth = h['authorization'] || '';

  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7);
    const isJwt = token.split('.').length === 3;
    return {
      type: isJwt ? 'Bearer JWT' : 'Bearer Token',
      pillClass: 'secured',
      icon: '🔐',
      color: 'var(--green)',
      rows: [],   // JWT-Details werden direkt in showAuth() dekodiert
      rawToken: token,
    };
  }
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const [user] = decoded.split(':');
      return { type: 'Basic Auth', pillClass: 'secured', icon: '🔐', color: 'var(--yellow)',
               rows: [['Benutzer', escHtml(user)], ['Passwort', '••••••••']] };
    } catch {
      return { type: 'Basic Auth', pillClass: 'secured', icon: '🔐', color: 'var(--yellow)', rows: [] };
    }
  }
  if (auth) {
    return { type: 'Authorization Header', pillClass: 'secured', icon: '🔐', color: 'var(--accent)',
             rows: [['Wert', maskToken(auth)]] };
  }

  const apiKeyHdrs = ['x-api-key','api-key','apikey','x-auth-key','x-access-key','x-functions-key'];
  for (const k of apiKeyHdrs) {
    if (h[k]) return { type: `API Key (${k})`, pillClass: 'secured', icon: '🔑', color: 'var(--orange)',
                       rows: [[k, maskToken(h[k])]] };
  }

  const tokenHdrs = ['x-auth-token','x-authentication','x-session-token','x-token','x-access-token'];
  for (const k of tokenHdrs) {
    if (h[k]) return { type: `Token (${k})`, pillClass: 'secured', icon: '🔑', color: 'var(--cyan)',
                       rows: [[k, maskToken(h[k])]] };
  }

  const csrf = h['x-csrf-token'] || h['x-xsrf-token'];
  if (csrf) return { type: 'CSRF Token', pillClass: 'secured', icon: '🛡', color: 'var(--purple)',
                     rows: [['Token', maskToken(csrf)]] };

  const cookie = h['cookie'];
  if (cookie) return { type: 'Cookie Session', pillClass: 'cookie', icon: '🍪', color: 'var(--yellow)',
                       rows: [['Cookie', escHtml(cookie.slice(0, 120)) + (cookie.length > 120 ? '…' : '')]] };

  return { type: 'Keine Authentifizierung', pillClass: 'none', icon: '🔓', color: 'var(--text2)', rows: [] };
}

function apiEndpoint(url) {
  try {
    const u = new URL(url);
    const q = u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search;
    return escHtml(u.hostname + u.pathname + q);
  } catch { return escHtml(url); }
}

function getFilteredApiRequests() {
  const text   = (document.getElementById('api-filter')?.value || '').toLowerCase();
  const method = document.getElementById('api-method-filter')?.value || '';
  const authOnly = document.getElementById('chk-api-auth-only')?.checked;
  return State.requests.filter(r => {
    if (!isApiRequest(r)) return false;
    if (text && !r.url.toLowerCase().includes(text) && !(r.method || '').toLowerCase().includes(text)) return false;
    if (method && r.method !== method) return false;
    if (authOnly) {
      const a = detectAuth(r);
      if (a.pillClass === 'none') return false;
    }
    return true;
  });
}

let selectedApiId = null;

function renderApiTable() {
  const rows  = getFilteredApiRequests();
  const tbody = document.getElementById('api-tbody');
  const empty = document.getElementById('api-empty');
  document.getElementById('api-count').textContent = rows.length;
  updateBadge('api', rows.length);

  if (!rows.length) { tbody.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  tbody.innerHTML = rows.map((r, i) => {
    const sc   = r.failed ? 'err4xx' : statusClass(r.status);
    const auth = detectAuth(r);
    const payload = r.postData
      ? `<span class="payload-tag">${fmt(r.postData.length)}</span>` : '—';
    return `<tr data-id="${escHtml(r.id)}" class="${selectedApiId === r.id ? 'selected' : ''}">
      <td class="mono num">${i + 1}</td>
      <td class="mono" style="color:var(--cyan)">${escHtml(r.method || 'GET')}</td>
      <td class="mono ${sc}">${r.failed ? 'ERR' : (r.status || '—')}</td>
      <td><span class="auth-pill ${auth.pillClass}">${auth.icon} ${escHtml(auth.type.split(' ')[0])}</span></td>
      <td class="mono" title="${escHtml(r.url)}" style="font-size:11px">${apiEndpoint(r.url)}<button class="row-copy-btn" data-copy="${escHtml(r.url)}" title="URL kopieren">⎘</button></td>
      <td class="num">${payload}</td>
      <td class="mono num">${fmtMs(r.timeMs)}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const req = State.requests.find(r => r.id === tr.dataset.id);
      if (req) showApiDetail(req);
    });
  });
}

// ── Batch-Request / Response Renderer ────────────────────────────────────────
const BATCH_RE = /\$batch(\/|$|\?)|\/batch\?api-version/i;

function renderBatchRequestBody(postData) {
  try {
    const batch = JSON.parse(postData);
    const reqs = batch.requests || (Array.isArray(batch) ? batch : null);
    if (!reqs?.length) return null;
    const items = reqs.map((sr, idx) => {
      const bodyStr = sr.body !== undefined
        ? `<div class="json-pre batch-body">${syntaxHL(escHtml(JSON.stringify(sr.body, null, 2).slice(0, 3000)))}</div>` : '';
      const depStr = sr.dependsOn?.length
        ? `<span class="batch-dep">⛓ dependsOn: ${escHtml(sr.dependsOn.join(', '))}</span>` : '';
      return `<div class="batch-item">
        <div class="batch-item-hdr">
          <span class="batch-idx">#${escHtml(String(sr.id ?? idx+1))}</span>
          <span class="batch-method">${escHtml(sr.method||'GET')}</span>
          <span class="batch-url">${escHtml(sr.url||'')}</span>
          ${depStr}
        </div>
        ${bodyStr}
      </div>`;
    }).join('');
    return bodySection(`Batch – ${reqs.length} Sub-Requests`, items);
  } catch { return null; }
}

function renderBatchResponseBody(body, postData) {
  try {
    const batchResp = JSON.parse(body);
    const subResps = batchResp.responses || (Array.isArray(batchResp) ? batchResp : null);
    if (!subResps?.length) return null;

    // Sub-Requests als Map für Korrelation
    const subReqMap = {};
    try {
      const batchReq = JSON.parse(postData || '{}');
      const reqs = batchReq.requests || (Array.isArray(batchReq) ? batchReq : []);
      reqs.forEach((sr, i) => { subReqMap[String(sr.id ?? i+1)] = sr; });
    } catch {}

    const items = subResps.map((sr, idx) => {
      const subReq = subReqMap[String(sr.id ?? idx+1)];
      const st = Number(sr.status || 0);
      const sc = st >= 400 ? 'err4xx' : st >= 200 ? 'batch-ok' : 'batch-status';
      const bodyStr = sr.body !== undefined
        ? `<div class="json-pre batch-body">${syntaxHL(escHtml(JSON.stringify(sr.body, null, 2).slice(0, 4000)))}</div>` : '';
      const asyncLink = sr.headers?.Location
        ? `<span class="batch-dep">⏳ async: ${escHtml(sr.headers.Location.slice(0, 80))}</span>` : '';
      return `<div class="batch-item">
        <div class="batch-item-hdr">
          <span class="batch-idx">#${escHtml(String(sr.id ?? idx+1))}</span>
          <span class="${sc}">${st || '?'}</span>
          ${subReq ? `<span class="batch-method">${escHtml(subReq.method||'')}</span>
          <span class="batch-url">${escHtml(subReq.url||'')}</span>` : ''}
          ${asyncLink}
        </div>
        ${bodyStr}
      </div>`;
    }).join('');
    return { html: items, label: `Batch Response – ${subResps.length} Sub-Antworten` };
  } catch { return null; }
}

async function showApiDetail(req) {
  selectedApiId = req.id;
  renderApiTable();
  const pane = document.getElementById('api-detail');
  const auth = detectAuth(req);

  // Korrelations-IDs die APIs gerne in Response-Headern mitschicken (vgl. X-Ray)
  const CORR_HDRS = ['x-request-id','x-correlation-id','request-id','x-ms-request-id',
                     'x-amzn-requestid','x-cloud-trace-context','traceparent','x-b3-traceid',
                     'ms-cv','x-vcap-request-id','cf-ray'];

  const corrIds = CORR_HDRS.flatMap(k => {
    const v = Object.entries(req.responseHeaders || {}).find(([h]) => h.toLowerCase() === k)?.[1];
    return v ? [[k, v]] : [];
  });

  pane.innerHTML = `
    <div class="detail-header" style="display:flex;align-items:center;gap:8px">
      <strong style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${apiEndpoint(req.url)}</strong>
      <button id="btn-copy-curl" style="font-size:10px;padding:2px 8px;white-space:nowrap">⎘ cURL</button>
    </div>
    <div class="detail-tabs">
      <div class="dtab active" data-dtab="request">Anfrage</div>
      <div class="dtab" data-dtab="response">Antwort</div>
      <div class="dtab" data-dtab="auth">Auth <span class="auth-pill ${auth.pillClass}" style="font-size:9px">${auth.icon}</span></div>
      ${corrIds.length ? `<div class="dtab" data-dtab="trace">🔗 Trace</div>` : ''}
    </div>
    <div class="detail-body" id="dapi-content" style="overscroll-behavior-y:contain"></div>`;

  const content = pane.querySelector('#dapi-content');

  // ── cURL Export (wie X-Ray's "Save script") ───────────────────────────────
  pane.querySelector('#btn-copy-curl').addEventListener('click', async (e) => {
    const hdrs = Object.entries(req.headers || {})
      .map(([k, v]) => `  -H '${k}: ${v.replace(/'/g, "'\\''")}'`)
      .join(' \\\n');
    const body = req.postData
      ? ` \\\n  --data-raw '${req.postData.replace(/'/g, "'\\''").slice(0, 4096)}'` : '';
    const curl = `curl -X ${req.method || 'GET'} \\\n  '${req.url}' \\\n${hdrs}${body}`;
    try { await navigator.clipboard.writeText(curl); } catch {
      const ta = document.createElement('textarea');
      ta.value = curl; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    e.target.textContent = '✓ Kopiert'; e.target.style.color = 'var(--green)';
    setTimeout(() => { e.target.textContent = '⎘ cURL'; e.target.style.color = ''; }, 1500);
  });

  function showRequest() {
    const hdrs = Object.entries(req.headers || {}).map(([k, v]) => {
      const isAuthHdr = /^(authorization|x-api-key|x-auth|cookie|x-csrf|x-token)/i.test(k);
      const vHtml = isAuthHdr
        ? `<span class="hl-auth">${escHtml(v.length > 80 ? v.slice(0,40)+'…'+v.slice(-8) : v)}</span>`
        : escHtml(v);
      return kvRow(k, vHtml, v);
    }).join('');

    // Erkenne API-Pfad-Muster und zeige Hinweis warum als API klassifiziert
    const reasons = [];
    if (req.type === 'xhr' || req.type === 'fetch') reasons.push(req.type.toUpperCase());
    if (req.mime?.includes('json')) reasons.push('JSON-Antwort');
    const ct = Object.entries(req.headers||{}).find(([k])=>k.toLowerCase()==='content-type')?.[1]||'';
    if (ct.includes('json')) reasons.push('JSON-Body');
    const acc = Object.entries(req.headers||{}).find(([k])=>k.toLowerCase()==='accept')?.[1]||'';
    if (acc.includes('json')) reasons.push('Accept: JSON');
    if (req.url && API_PATH_RE.test(req.url)) reasons.push('API-URL-Muster');
    if (req.url && API_HOST_RE.test(new URL(req.url||'http://x').hostname)) reasons.push('API-Subdomain');

    let payloadHtml = '';
    if (req.postData) {
      if (BATCH_RE.test(req.url || '')) {
        payloadHtml = renderBatchRequestBody(req.postData) || '';
      }
      if (!payloadHtml) {
        let pretty = req.postData;
        try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch {}
        payloadHtml = bodySection('Request Body / Payload',
          `<div class="json-pre" style="margin-top:6px">${syntaxHL(escHtml(pretty.slice(0, 10000)))}</div>`);
      }
    }

    const initiatorHtml = escHtml(req.initiatorType||'') + (req.initiatorUrl
      ? ' <span style="color:var(--text1)">·</span> <span style="color:var(--cyan);font-size:10px">'+escHtml(filename(req.initiatorUrl))+'</span>' : '');
    content.innerHTML = `
      <table class="kv-table" style="margin-bottom:8px">
        ${kvRow('URL', `<span style="word-break:break-all">${escHtml(req.url)}</span>`, req.url)}
        ${kvRow('Methode', `<span style="color:var(--cyan)">${escHtml(req.method||'')}</span>`, req.method||'')}
        ${kvRow('Klassifiziert als API', `<span style="color:var(--text1);font-size:10px">${reasons.map(r=>`<span class="payload-tag">${escHtml(r)}</span>`).join(' ')}</span>`, reasons.join(', '))}
        ${kvRow('Initiator', initiatorHtml, req.initiatorType||'')}
      </table>
      <b style="color:var(--accent);font-size:11px">Request Headers</b>
      <table class="kv-table" style="margin:6px 0">${hdrs}</table>
      ${payloadHtml}`;
  }

  async function showResponse() {
    content.innerHTML = '<i style="color:var(--text2)">Lade Body …</i>';
    const resHdrs = Object.entries(req.responseHeaders || {}).map(([k, v]) => kvRow(k, escHtml(v))).join('');

    let bodyHtml = '';
    let bodyLabel = 'Response Body';
    const res = await window.cdp.getBody(req.id);
    if (res.ok) {
      const { body, base64Encoded } = res.result;
      if (base64Encoded) {
        bodyHtml = `<i style="color:var(--text1)">Base64 (${fmt(body?.length || 0)} Zeichen)</i>`;
      } else if (BATCH_RE.test(req.url || '')) {
        const batchResult = renderBatchResponseBody(body || '', req.postData || '');
        if (batchResult) { bodyHtml = batchResult.html; bodyLabel = batchResult.label; }
        else {
          let pretty = body || '';
          try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch {}
          bodyHtml = `<div class="json-pre">${syntaxHL(escHtml(pretty.slice(0, 12000)))}</div>`;
        }
      } else {
        let pretty = body || '';
        try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch {}
        bodyHtml = `<div class="json-pre">${syntaxHL(escHtml(pretty.slice(0, 12000)))}</div>`;
      }
    } else {
      bodyHtml = `<span style="color:var(--text2)">${escHtml(res.error)}</span>`;
    }

    const sc = req.failed ? 'err4xx' : statusClass(req.status);
    const statusTxt = req.failed ? 'FAILED – '+(req.errorText||'') : (req.status||'')+' '+(req.statusText||'');
    content.innerHTML = `
      <table class="kv-table" style="margin-bottom:8px">
        ${kvRow('Status', `<span class="${sc}">${escHtml(statusTxt)}</span>`, statusTxt)}
        ${kvRow('MIME', escHtml(req.mime||''))}
        ${kvRow('Protokoll', escHtml(req.protocol||''))}
        ${kvRow('Remote IP', escHtml(req.remoteAddress||''))}
        ${kvRow('Größe', fmt(req.size))}
        ${kvRow('Zeit', fmtMs(req.timeMs))}
      </table>
      <b style="color:var(--accent);font-size:11px">Response Headers</b>
      <table class="kv-table" style="margin:6px 0">${resHdrs}</table>
      ${bodyHtml ? bodySection(bodyLabel, bodyHtml) : ''}`;
  }

  function showAuth() {
    // JWT-Dekodierung direkt hier, damit der volle Token verfügbar ist
    let jwtHtml = '';
    if (auth.rawToken) {
      jwtHtml = decodeJwtForDisplay(auth.rawToken) || '';
    }

    const baseRows = auth.rows.map(([k, v]) =>
      `<tr><td>${escHtml(k)}</td><td>${v}</td></tr>`
    ).join('');

    content.innerHTML = `
      <div class="auth-section">
        <h4>Erkannte Authentifizierung</h4>
        <div class="auth-type-row" style="color:${auth.color}">${auth.icon} ${escHtml(auth.type)}</div>
        ${baseRows ? `<table class="claim-table">${baseRows}</table>` : ''}
      </div>
      ${jwtHtml ? `<div class="auth-section jwt-decoded">${jwtHtml}</div>` : ''}
      ${auth.pillClass === 'none' ? `
      <div class="auth-section" style="border-color:var(--border)">
        <h4 style="color:var(--text2)">Hinweis</h4>
        <p style="font-size:11px;color:var(--text1);line-height:1.6">
          Dieser Request enthält keine erkennbaren Auth-Header.<br>
          Mögliche Gründe: Session-Cookie in anderem Request gesetzt,
          CORS-Preflight, öffentlicher Endpunkt, oder Auth via Query-Parameter.
        </p>
      </div>` : ''}`;
  }

  function showTrace() {
    const rows = corrIds.map(([k, v]) =>
      `<tr><td style="color:var(--text1)">${escHtml(k)}</td><td style="word-break:break-all">${escHtml(v)}</td></tr>`
    ).join('');
    content.innerHTML = `
      <div class="auth-section">
        <h4>Request / Trace IDs</h4>
        <p style="font-size:10px;color:var(--text2);margin-bottom:8px">
          Korrelations-IDs aus den Response-Headers — ähnlich wie Microsoft Graph X-Ray's Request-ID.
          Diese IDs können in Server-Logs zur Fehlersuche verwendet werden.
        </p>
        <table class="claim-table">${rows}</table>
      </div>`;
  }

  showRequest();
  pane.querySelectorAll('.dtab').forEach(dt => {
    dt.addEventListener('click', () => {
      pane.querySelectorAll('.dtab').forEach(d => d.classList.remove('active'));
      dt.classList.add('active');
      if (dt.dataset.dtab === 'request')  showRequest();
      else if (dt.dataset.dtab === 'response') showResponse();
      else if (dt.dataset.dtab === 'trace') showTrace();
      else showAuth();
    });
  });
}

['api-filter', 'api-method-filter', 'chk-api-auth-only'].forEach(id => {
  document.getElementById(id)?.addEventListener('input',  renderApiTable);
  document.getElementById(id)?.addEventListener('change', renderApiTable);
});

App.api = {
  clear() {
    selectedApiId = null;
    document.getElementById('api-tbody').innerHTML = '';
    document.getElementById('api-empty').style.display = 'flex';
    document.getElementById('api-detail').innerHTML = '<div class="empty"><div class="icon">←</div><p>Request auswählen</p></div>';
    updateBadge('api', 0);
    document.getElementById('api-count').textContent = '0';
  },
};

// ── Init ──────────────────────────────────────────────────────────────────────

// Resizable split-Divider: Ziehen am .resize-handle ändert split-right-Breite
(function initResizeHandles() {
  document.querySelectorAll('.resize-handle').forEach(handle => {
    const right = handle.nextElementSibling;
    if (!right) return;
    let startX = 0, startW = 0;

    handle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = right.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = e => {
        const w = Math.max(180, Math.min(900, startW + (startX - e.clientX)));
        right.style.width = w + 'px';
      };
      const onUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  });
})();

// Click-to-Copy auf kv-val Zellen und Body-Sektionen (Detail-Panes)
['net-detail', 'asset-detail', 'api-detail'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', e => {
    const copyBtn = e.target.closest('.copy-block-btn');
    if (copyBtn) {
      const section = copyBtn.closest('.body-section');
      const el = section?.querySelector('.json-pre, pre');
      copyToClipboard(el?.textContent?.trim() || '');
      copyBtn.textContent = '✓ Kopiert';
      setTimeout(() => copyBtn.textContent = '⎘ Kopieren', 1400);
      return;
    }
    const td = e.target.closest('.kv-val');
    if (td) copyToClipboard(td.dataset.copy ?? td.textContent.trim());
  });
});

// Click-to-Copy für Zeilen-Copy-Buttons in Tabellen
['net-tbl-wrap', 'api-tbl-wrap'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', e => {
    const btn = e.target.closest('.row-copy-btn');
    if (btn) { e.stopPropagation(); copyToClipboard(btn.dataset.copy); }
  });
});

loadTargets();

// Kontext alle 2 Sek. an Main-Prozess pushen (für AI-Fenster)
setInterval(() => {
  if (!State.connected) return;
  window.cdp.pushContext({
    requests: State.requests.slice(-100).map(r => ({
      method: r.method, status: r.status, type: r.type, url: r.url,
      size: r.size, timeMs: r.timeMs, initiatorType: r.initiatorType,
      mime: r.mime, failed: r.failed, errorText: r.errorText,
    })),
    scripts: [...State.scripts.values()].map(s => ({ scriptId: s.scriptId, url: s.url })),
    pausedState: State.paused ? {
      paused: true,
      frames: State.pausedFrames.slice(0, 5).map(f => ({
        functionName: f.functionName,
        url: f.url,
        lineNumber: f.location?.lineNumber,
        columnNumber: f.location?.columnNumber,
      })),
    } : null,
    consoleEntries: State.consoleEntries.slice(-50).map(e => ({
      type: e.type,
      text: e.args?.map(a => a.value ?? a.description ?? a.type).join(' ') || '',
    })),
  });
}, 2000);
