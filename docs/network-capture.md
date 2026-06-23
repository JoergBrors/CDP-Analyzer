# Network Capture — CDP Integration

## Wie Chrome-Traffic erfasst wird

### Ebene 1: Standard CDP Network Domain

Aktiviert mit `Network.enable({ maxPostDataSize: 65536 })`.

Events die ankommen:
- `Network.requestWillBeSent` → URL, Methode, Headers, PostData
- `Network.responseReceived` → Status, Response-Headers, MIME-Type
- `Network.loadingFinished` → Request abgeschlossen, Body jetzt abrufbar
- `Network.loadingFailed` → Fehler-Text

### Ebene 2: Worker & Service Worker (Target.setAutoAttach)

```js
await cdpSend('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,   // alle Sessions über eine WebSocket-Verbindung, mit sessionId
});
```

Sub-Target-Events kommen mit `sessionId` im CDP-Message. `routeEvent()` leitet sie an `toRenderer()` weiter — der Renderer sieht Worker-Requests genauso wie Hauptseiten-Requests, nur mit einem `sessionId`-Feld.

Für jeden neuen Worker wird `Network.enable` auch in dessen Session aufgerufen (`onTargetAttached()`).

### Ebene 3: Deep Intercept (optional, manuell aktivieren)

Zwei Mechanismen gleichzeitig:

**a) Fetch.enable** — pausiert jeden Request im Browser:

```js
await cdpSend('Fetch.enable', {});
// → Fetch.requestPaused Event für jeden Request
// → sofort weiterleiten: cdpSend('Fetch.continueRequest', { requestId })
```

**b) Monkey-Patch via Page.addScriptToEvaluateOnNewDocument** — läuft VOR Seiten-JavaScript:

```js
// Überschreibt: window.fetch, XMLHttpRequest.prototype.open/send,
//               navigator.sendBeacon, window.WebSocket, window.EventSource
// Meldet via Runtime.addBinding('__cdpHidden')
```

Fängt ab was im Network-Panel oft unsichtbar bleibt:
- `sendBeacon` (Tracking, Analytics)
- WebSocket-Frames (Text-Content)
- SSE-Verbindungen
- Requests aus `eval()`-Code

---

## Proaktiver Response-Body-Cache

### Problem

Chrome verwirft Response-Bodies aus dem Speicher wenn sie nicht innerhalb kurzer Zeit per `Network.getResponseBody` abgerufen werden. Bei SPA-Navigation kann das wenige Sekunden sein.

### Lösung: Cache bei `loadingFinished`

```js
// In routeEvent():
if (method === 'Network.responseReceived') {
  requestInfoCache.set(requestId, { mimeType: response.mimeType, url: response.url });
}

if (method === 'Network.loadingFinished') {
  const info = requestInfoCache.get(requestId);
  if (info && shouldCacheBody(info.mimeType, info.url)) {
    cdpSend('Network.getResponseBody', { requestId }, sessionId)
      .then(result => {
        responseBodyCache.set(requestId, { body: result.body, base64Encoded: !!result.base64Encoded });
        evictBodyCache();
      })
      .catch(() => {});   // kein Problem wenn Body schon weg
  }
}
```

### Was gecacht wird (`shouldCacheBody`)

```js
const API_BODY_RE = /json|graphql|xml|text\/plain/i;
const API_URL_RE  = /\/(?:api|v\d+(?:\.\d+)*|graphql|odata|batch|...)\//i;

function shouldCacheBody(mimeType, url) {
  return API_BODY_RE.test(mimeType) || API_URL_RE.test(url);
}
```

Bilder, Videos, Fonts etc. werden **nicht** gecacht.

### Cache-Größe und LRU

```js
const MAX_BODY_CACHE = 400;

function evictBodyCache() {
  if (responseBodyCache.size > MAX_BODY_CACHE) {
    const toDelete = responseBodyCache.size - MAX_BODY_CACHE;
    let i = 0;
    for (const k of responseBodyCache.keys()) {
      responseBodyCache.delete(k);
      if (++i >= toDelete) break;
    }
  }
}
```

`Map` in JavaScript erhält Insertion-Reihenfolge → älteste Einträge werden zuerst gelöscht.

---

## API-Erkennung (Filterung für API-Panel)

Zwei Regexes entscheiden ob ein Request als "API" gilt:

```js
// URL-Pfad:
const API_RE = /\/(?:api|rest|graphql|v\d+(?:\.\d+)*|odata|intents|releases|
                batch|policies|settings|admin|health|reports?|metric|telemetry|
                collector|permissions?|graph|sync|deploy|config)\//i;

// Hostname:
const HOST_RE = /(?:api\.|apis\.|graph\.|platform\.|gateway\.|config\.|
                 portal\.|data\.|events\.|analytics\.|collector\.|management\.)/i;
```

Zusätzlich gelten alle Requests vom Typ `xhr` oder `fetch` immer als API.

### Bekannte Muster die erkannt werden

| Muster | Beispiel |
| --- | --- |
| `graph.microsoft.com` | Microsoft Graph |
| `/v1.0/` `/v1/` `/v2/` | REST-Versionen |
| `/$batch` | Microsoft Graph Batch |
| `config.office.com` | Office-Konfiguration |
| `management.azure.com` | Azure Management |
| `/api/` | Generic REST |
| `/graphql` | GraphQL |

---

## Batch-Request-Analyse

Microsoft Graph `$batch` und ähnliche Endpoints bündeln mehrere Sub-Requests in einem HTTP-Call.

### Request-Body Format

```json
{
  "requests": [
    { "id": "1", "method": "GET", "url": "/v1.0/me" },
    { "id": "2", "method": "GET", "url": "/v1.0/users", "dependsOn": ["1"] }
  ]
}
```

### Response-Body Format

```json
{
  "responses": [
    { "id": "1", "status": 200, "body": { ... } },
    { "id": "2", "status": 200, "body": { ... } }
  ]
}
```

Korrelation in `renderer.js`:

```js
function renderBatchResponseBody(body, postData) {
  const subReqMap = {};
  // postData parsen → subReqMap[id] = { method, url, dependsOn }
  // body.responses → für jede Response: subReqMap[resp.id] nachschlagen
  // Darstellung: Sub-Request + Status + Sub-Response-Body
}
```

Asynchrone Batch-Responses (HTTP 202 + Location-Header) werden erkannt und entsprechend markiert.
