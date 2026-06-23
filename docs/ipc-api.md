# IPC API Referenz

Alle Kommunikationswege zwischen Electron Main (`src/main.js`) und den Renderer-Prozessen.

---

## CDP — Browser-Verbindung (`window.cdp.*`)

Exponiert via `src/preload.js`.

### `cdp.getTargets() → { ok, targets[] }`

Ruft offene Chrome-Tabs von `http://localhost:9222/json` ab.

```js
const { ok, targets } = await window.cdp.getTargets();
// targets[n]: { title, url, webSocketDebuggerUrl, type, id }
```

### `cdp.connect(wsUrl) → { ok }`

Verbindet sich mit einem Chrome-Tab über dessen WebSocket-URL.

```js
await window.cdp.connect('ws://localhost:9222/devtools/page/ABC...');
```

### `cdp.send(method, params) → { ok, result }`

Sendet einen beliebigen CDP-Befehl.

```js
const { result } = await window.cdp.send('Runtime.evaluate', { expression: '1+1' });
```

### `cdp.getBody(requestId) → { ok, result: { body, base64Encoded } }`

Lädt Response-Body. Prüft zuerst den proaktiven Cache, dann live per CDP.

### `cdp.deepIntercept(enable) → { ok, enabled }`

Aktiviert/deaktiviert Deep Intercept (Fetch.enable + Monkey-Patch-Injektion).

### `cdp.setBreakpoint({ scriptId, lineNumber }) → { ok, result }`

### `cdp.removeBreakpoint(breakpointId) → { ok }`

### `cdp.debuggerStep(action) → { ok }`

`action`: `'resume'` | `'stepOver'` | `'stepInto'` | `'stepOut'` | `'pause'`

### `cdp.evaluate({ expression, callFrameId }) → { ok, result }`

JavaScript im Browser-Kontext auswerten (mit optionalem Debugger-Frame).

### `cdp.getScriptSource(scriptId) → { ok, result: { scriptSource } }`

### `cdp.getProperties({ objectId }) → { ok, result }`

---

## AI — Schlüssel & Modelle (`window.ai.*`)

Exponiert via `src/preload-ai.js`.

### `ai.saveKey(provider, key) → { ok }`

Speichert API-Key verschlüsselt via `safeStorage`.

- `provider`: `'gemini'` | `'openai'`
- Datei: `~/Library/Application Support/cdp-analyzer/ai-key.json`
- Format: `{ enc: true, keys: { gemini: "<base64>", openai: "<base64>" } }`

### `ai.loadKey(provider?) → key | { keys: { gemini, openai } }`

Lädt und entschlüsselt gespeicherte Keys.

- Ohne `provider`: gibt Objekt mit allen Keys zurück
- Mit `provider`: gibt einzelnen Key-String zurück

### `ai.getContext(type) → { ok, data }`

Liefert aufbereitete CDP-Daten für den AI-Agenten.

| type | Inhalt |
| --- | --- |
| `'api'` | Letzte 50 API-Requests mit `id`, `hasBody`, JWT-decodierten Headers |
| `'network'` | Letzte 50 HTTP-Requests (Metadaten) |
| `'errors'` | Alle Requests mit Status ≥ 400 oder `failed: true` |
| `'scripts'` | Geladene JavaScript-Dateien |
| `'console'` | Letzte 30 Console-Einträge |
| `'paused'` | Aktueller Debugger-Pause-Zustand |

### `ai.getResponseBody(requestId) → { ok, body, base64Encoded? }`

Lädt Response-Body eines Requests. Cache-first, dann Live-CDP-Fetch.

- `body`: bis zu 80.000 Zeichen
- `base64Encoded: true`: binärer Content, Body ist `<Base64, N Zeichen>`

### `ai.searchBodies(query, maxResults?) → { ok, results[], searched }`

Volltext-Suche in allen gecachten Request- und Response-Bodies.

```js
// Beispiel-Ergebnis:
{
  ok: true,
  query: 'displayName',
  results: [{
    type: 'response',       // oder 'request'
    requestId: 'ABC123',
    url: 'https://graph.microsoft.com/v1.0/$batch',
    method: 'POST',
    status: 200,
    snippets: ['...\"displayName\": \"John Doe\"...']
  }],
  searched: { responseBodies: 42, requestBodies: 15 }
}
```

---

## Browser-Steuerung (`window.ai.browser.*`)

### `ai.browser.navigate(url) → { ok }`

### `ai.browser.evaluate(expression) → { ok, result, type }`

### `ai.browser.screenshot() → { ok, data }` — `data` ist PNG base64

### `ai.browser.reload() → { ok }`

### `ai.browser.getContent() → { ok, result: { url, title, text } }`

---

## Events (Main → Renderer)

Via `window.cdp.on(channel, callback)` / `window.ai.on(channel, callback)`.

| Channel | Richtung | Payload |
| --- | --- | --- |
| `cdp:status` | Main → Renderer | `{ connected: bool, url? }` |
| `cdp:network` | Main → Renderer | `{ method, params, sessionId? }` |
| `cdp:debugger` | Main → Renderer | `{ method, params }` |
| `cdp:runtime` | Main → Renderer | `{ method, params }` |
| `cdp:page` | Main → Renderer | `{ method, params }` |
| `cdp:hidden` | Main → Renderer | `{ source, sessionId?, data }` |
| `cdp:error` | Main → Renderer | Fehler-String |

### `cdp:hidden` — Quellen

| `source` | Beschreibung |
| --- | --- |
| `'fetch'` | Deep Intercept: Fetch.requestPaused |
| `'xhr'` | Monkey-Patch: XMLHttpRequest |
| `'beacon'` | Monkey-Patch: navigator.sendBeacon |
| `'websocket'` | Monkey-Patch: WebSocket.send |
| `'eventsource'` | Monkey-Patch: EventSource |
| `'target'` | Worker/Service Worker attached/detached |

---

## Shared Context

Der Renderer aktualisiert `sharedContext` im Main via:

```js
window.cdp.on('ai:updateContext') // wird vom renderer.js automatisch gesendet
```

Felder in `sharedContext`:

```js
{
  requests:       Request[],  // alle Network-Requests (max ~50 aktiv)
  scripts:        Script[],   // geladene JS-Dateien
  pausedState:    object,     // Debugger-Pause (null wenn nicht pausiert)
  consoleEntries: Entry[],    // Console-Log-Einträge
}
```

### Request-Objekt (in `sharedContext.requests`)

```js
{
  id:              string,   // CDP requestId → für getResponseBody
  method:          string,   // HTTP-Methode
  url:             string,
  status:          number,
  type:            string,   // 'xhr' | 'fetch' | 'script' | 'document' | ...
  mime:            string,   // MIME-Type der Antwort
  size:            number,   // Bytes
  timeMs:          number,   // Dauer in ms
  headers:         object,   // Request-Headers
  responseHeaders: object,   // Response-Headers
  postData:        string?,  // Request-Body (bis 65536 Zeichen)
  failed:          boolean,
  errorText:       string?,
}
```
