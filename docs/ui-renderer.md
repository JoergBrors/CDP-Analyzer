# UI & Renderer — Implementierungsdetails

## Panel-Struktur (`index.html` + `src/renderer.js`)

```
index.html
├── #topbar           — Verbindungs-Status, Targets-Dropdown, AI-Analyst-Button
├── #tab-bar          — Network | Assets | Debugger | Console | API
└── #panels
    ├── #panel-network
    │   ├── #net-table-wrap   — Scrollbare Tabelle mit Request-Zeilen
    │   └── #detail-pane      — Headers / Body / Timing bei ausgewähltem Request
    ├── #panel-assets         — Gefilterte Asset-Liste + Vorschau
    ├── #panel-debugger       — Script-Liste / Source / Breakpoints / Scope / Stack
    ├── #panel-console        — Log-Einträge + REPL
    └── #panel-api
        ├── #api-table-wrap   — API-Request-Liste
        └── #api-detail       — Request / Response / Batch / Auth Tabs
```

---

## Resizable Panels

Split-Drag zwischen Tabellen-Pane und Detail-Pane:

```js
let dragging = false, startX = 0, startW = 0;
divider.addEventListener('mousedown', e => {
  dragging = true; startX = e.clientX;
  startW = parseInt(getComputedStyle(tableWrap).width);
});
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  tableWrap.style.width = Math.max(200, startW + (e.clientX - startX)) + 'px';
});
document.addEventListener('mouseup', () => dragging = false);
```

---

## Copy-Buttons

### Prinzip: Event-Delegation

Statt jedem Button einen Listener zu geben, ein zentraler Handler:

```js
document.addEventListener('click', (e) => {
  // Header-Wert kopieren:
  if (e.target.classList.contains('copy-val')) {
    navigator.clipboard.writeText(e.target.closest('tr').dataset.val);
  }
  // Body-Block kopieren:
  if (e.target.classList.contains('copy-block-btn')) {
    const block = e.target.closest('.body-section').querySelector('pre, .json-viewer');
    navigator.clipboard.writeText(block.textContent);
  }
  // Code-Block im AI-Chat kopieren:
  if (e.target.classList.contains('code-copy-btn')) {
    navigator.clipboard.writeText(e.target.closest('pre').querySelector('code').textContent);
  }
});
```

### Body-Section Helper

```js
function bodySection(label, bodyHtml) {
  return `<div class="body-section">
    <div class="section-hdr">
      <b>${label}</b>
      <button class="copy-block-btn">⎘ Kopieren</button>
    </div>
    ${bodyHtml}
  </div>`;
}
```

---

## Batch-Darstellung (`renderer.js`)

### Erkennung

```js
const BATCH_RE = /\$batch(\/|$|\?)|\/batch\?api-version/i;
```

### Request-Body-Darstellung

```js
function renderBatchRequestBody(postData) {
  const batch = JSON.parse(postData);
  return batch.requests.map((req, i) => `
    <div class="batch-item">
      <div class="batch-item-hdr">
        <span class="batch-idx">#${i+1}</span>
        <span class="batch-method">${req.method}</span>
        <span class="batch-url">${req.url}</span>
        ${req.dependsOn ? `<span class="batch-dep">→ hängt von #${req.dependsOn.join(', #')}</span>` : ''}
      </div>
      ${req.body ? `<div class="batch-body">${formatJson(req.body)}</div>` : ''}
    </div>
  `).join('');
}
```

### Response-Body-Korrelation

```js
function renderBatchResponseBody(body, postData) {
  // Sub-Requests aus postData indexieren:
  const subReqMap = {};
  JSON.parse(postData).requests?.forEach(r => { subReqMap[r.id] = r; });

  // Responses mit Sub-Requests korrelieren:
  JSON.parse(body).responses?.forEach(resp => {
    const req = subReqMap[resp.id];
    // Darstellung: Methode + URL aus req, Status + Body aus resp
    const isAsync = resp.status === 202 && resp.headers?.Location;
  });
}
```

---

## JSON-Formatierung

```js
function formatJson(data) {
  let obj = data;
  if (typeof data === 'string') {
    try { obj = JSON.parse(data); } catch { return `<pre>${escHtml(data)}</pre>`; }
  }
  return `<pre class="json-body">${syntaxHighlight(JSON.stringify(obj, null, 2))}</pre>`;
}

function syntaxHighlight(json) {
  return escHtml(json).replace(
    /(".*?")(\s*:)|(".*?"(?!:))|(\b\d+\.?\d*\b)|(true|false|null)/g,
    (_, key, colon, str, num, kw) =>
      key   ? `<span class="json-key">${key}</span>${colon}` :
      str   ? `<span class="json-str">${str}</span>` :
      num   ? `<span class="json-num">${num}</span>` :
              `<span class="json-kw">${kw}</span>`
  );
}
```

---

## Timing-Visualisierung

Wasserfalldiagramm per CSS-Balken:

```js
function renderTiming(timing) {
  const total = timing.receiveHeadersEnd || 1;
  const bars = [
    { label: 'DNS',     start: 0,                   end: timing.dnsEnd,              color: '#58a6ff' },
    { label: 'Connect', start: timing.connectStart,  end: timing.connectEnd,          color: '#3fb950' },
    { label: 'SSL',     start: timing.sslStart,      end: timing.sslEnd,              color: '#d29922' },
    { label: 'Send',    start: timing.sendStart,      end: timing.sendEnd,             color: '#a371f7' },
    { label: 'Wait',    start: timing.sendEnd,        end: timing.receiveHeadersEnd,   color: '#f78166' },
  ];
  // CSS: left = start/total*100%, width = (end-start)/total*100%
}
```

---

## CSS-Architektur

Alle Styles in `index.html` (kein externes CSS), aufgeteilt in Sektionen:

```
Variables:    --bg, --bg2, --border, --text, --accent, ...
Reset:        *, body, html
Layout:       #topbar, #tab-bar, #panels, resizable panes
Tables:       .net-table, .api-table (gemeinsame Basis-Styles)
Detail:       #detail-pane, .tab-bar, .header-section, .timing-bar
Batch:        .batch-item, .batch-item-hdr, .batch-method, .batch-url
JWT/Auth:     .jwt-bar, .jwt-badges, .jwt-grid, .jwt-perms, .jwt-chip
Debugger:     .script-list, .source-view, .scope-tree, .call-stack
Console:      .log-entry, .log-warn, .log-error, .repl-input
Buttons:      .copy-val, .copy-block-btn, .section-hdr
```

---

## Markdown-Rendering im AI-Chat

Minimaler eingebetteter Markdown-Parser (`markdownToHtml`):

```js
function markdownToHtml(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${lang}">${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^#{1,3} (.+)$/gm, (_, t) => `<h3>${t}</h3>`)
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[huplo])/gm, '')   // Zeilen ohne Block-Tag in p
    ;
}
```

**Wichtig**: Dieser Parser wird NUR nach dem vollständigen Stream aufgerufen, nie für einzelne Chunks.
