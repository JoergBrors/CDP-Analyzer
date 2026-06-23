# Entwicklungshistorie

Verlauf der Features und technischen Entscheidungen die zum aktuellen Stand geführt haben.
Geordnet nach Themen, nicht chronologisch.

---

## Grundstruktur (Phase 1)

### Ziel

Electron-App die sich in Chrome einklinkt und Netzwerk-Traffic anzeigt.

### Implementiert

- CDP-WebSocket-Verbindung zu `localhost:9222`
- Target-Auswahl (offene Chrome-Tabs)
- Network-Panel: Live-Requests mit URL, Methode, Status, Typ, Größe, Zeit
- Detail-Pane: Headers, Body (JSON-formatiert), Timing-Waterfall
- Assets-Panel: Bilder/Scripts/CSS/Fonts mit Vorschau
- Debugger-Panel: Scripts, Breakpoints, Step-Through, Scope-Explorer, Call Stack, Object Watcher
- Console-Panel: Live-Logs + JavaScript-REPL

---

## Worker & Hidden Traffic (Phase 2)

### Problem

Service Worker und Web Worker machen eigene Netzwerkanfragen die im Network-Panel unsichtbar sind. Dasselbe gilt für `sendBeacon`, WebSocket-Frames und SSE.

### Lösung 1: Target.setAutoAttach

```js
await cdpSend('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
});
```

Alle Worker-Sessions kommen über die gleiche WebSocket-Verbindung mit einer `sessionId`. `Network.enable` wird für jede neue Session aufgerufen.

### Lösung 2: Deep Intercept (optional)

`Fetch.enable` pausiert alle Requests. Parallel wird ein Monkey-Patch-Script injiziert das `fetch`, `XHR`, `sendBeacon`, `WebSocket` und `EventSource` überschreibt und über eine CDP-Binding (`Runtime.addBinding`) meldet.

Das Script wird via `Page.addScriptToEvaluateOnNewDocument` vor Seiten-JavaScript eingefügt — auch bei SPA-Navigation aktiv.

---

## AI Browser Analyst (Phase 3)

### Entscheidung: Separates Fenster

Der AI-Chat läuft in einem eigenen `BrowserWindow` mit eigenem Preload (`preload-ai.js`). Vorteile:
- Kann unabhängig positioniert/minimiert werden
- Eigener Kontext (kein Zugriff auf Renderer-DOM)
- Saubere IPC-Grenze für Kontext-Daten

### Provider-Dualität

Beide Provider (Gemini + OpenAI) nutzen die gleiche `executeTool()`-Funktion. Tool-Definitionen werden einmal in `GEMINI_TOOLS` definiert und via `convertParamsToOpenAI()` automatisch ins OpenAI-Format konvertiert.

### Streaming-Bug und Fix

**Bug**: Text erschien Wort für Wort in einer schmalen Spalte.

**Ursache**: `bubble.innerHTML += markdownToHtml(chunk)` für jeden Streaming-Chunk. Jeder Chunk wurde als eigenes `<p>` gerendert, Markierung veränderte DOM und zerstörte den Cursor.

**Fix**:
```js
// WÄHREND Stream:
content.textContent = bubbleText;    // Plain text, kein Parser

// NACH Stream (cursor bereits entfernt):
content.innerHTML = markdownToHtml(escHtml(bubbleText));
```

`content` und `cursor` sind jetzt Geschwister-Elemente, nicht verschachtelt.

### Layout-Bug (macOS)

**Bug**: Topbar überdeckte macOS Traffic-Light-Buttons (⚫🟡🟢).

**Fix**: `padding-left: 80px` auf `#topbar` (nur macOS, via `titleBarStyle: 'hiddenInset'`).

### Bubble-Breite während Stream

**Bug**: AI-Antwort-Bubble schrumpfte während des Streamings auf minimale Breite.

**Ursache**: `align-self: flex-start` auf `.msg.assistant .msg-bubble` — Bubble wurde so breit wie ihr Inhalt.

**Fix**: `width: 100%` auf `.msg.assistant .msg-bubble`.

---

## API-Panel (Phase 4)

### Ziel

Separate Ansicht nur für API-relevante Requests mit strukturierter Analyse.

### API-Erkennung

Erste Version erkannte nur `xhr`/`fetch`. Erweitert um:
- URL-Pattern: `v\d+` (erkennt `/v1.0/` wegen `(?:\.\d+)*`)
- Host-Pattern: `config.`, `data.`, `events.`, `analytics.`, `management.`

**Bug**: `/v1.0/` wurde nicht erkannt weil `v\d+` nur auf ganzzahlige Versionen matched.

**Fix**: `v\d+(?:\.\d+)*` — matcht `v1`, `v1.0`, `v2.1.3` etc.

### Batch-Analyse

Microsoft Graph `$batch` bündelt Sub-Requests. Die App:
1. Erkennt `$batch` im URL via `BATCH_RE`
2. Parst Request-Body: `{ requests: [{ id, method, url, dependsOn, body }] }`
3. Parst Response-Body: `{ responses: [{ id, status, body }] }`
4. Korreliert per `id`-Feld → zeigt Sub-Request + Sub-Response zusammen

Asynchrone Batch-Responses (HTTP 202 + Location-Header) werden separat markiert.

---

## JWT Decoder (Phase 5)

### Ziel

Bearer-Tokens aus API-Requests client-seitig decodieren, im Auth-Tab anzeigen und für AI lesbar machen.

### Implementierung

Vollständig client-seitig via `atob()`. Keine externe Library, kein Server-Call.

Base64url → Base64: `-` → `+` und `_` → `/`.

Microsoft Entra ID erkannt via Issuer-URL (`login.microsoftonline.com`).

### Bug beim Refactoring

**Bug**: `parseJwt()` return type änderte sich → `detectAuth()` crash weil es ein Array erwartete.

**Fix**: `detectAuth()` speichert jetzt `rawToken` (String), `showAuth()` ruft `decodeJwtForDisplay(rawToken)` direkt auf.

---

## Proaktiver Body-Cache (Phase 6)

### Problem

Chrome evicted Response-Bodies nach kurzer Zeit aus dem Speicher. Nutzer klickte auf eine Zeile, bekam aber "Body nicht verfügbar".

### Lösung

Bei `Network.loadingFinished`: sofort `Network.getResponseBody` aufrufen wenn MIME-Type oder URL auf API hindeutet. Ergebnis in `responseBodyCache` (Map mit LRU-Eviction, max 400 Einträge).

```js
// routeEvent():
if (method === 'Network.loadingFinished') {
  const info = requestInfoCache.get(requestId);
  if (info && shouldCacheBody(info.mimeType, info.url)) {
    cdpSend('Network.getResponseBody', { requestId }, sessionId)
      .then(result => responseBodyCache.set(requestId, result))
      .catch(() => {});
  }
}
```

---

## AI kann Daten durchsuchen (Phase 7)

### Problem

Agent antwortete "Ich kann die Batch-Response-Inhalte nicht sehen, da nur Metadaten sichtbar sind."

### Lösung: Zwei neue Tools

**`getResponseBody(requestId)`** — lädt einen spezifischen Response-Body aus dem Cache:
- `requestId` kommt aus `getCdpContext("api")[n].id`
- Prüft zuerst `responseBodyCache`, dann Live-CDP-Fetch
- Bis 80.000 Zeichen, JSON wird pretty-printed

**`searchInData(query, maxResults?)`** — Volltext-Suche:
- Durchsucht alle `responseBodyCache`-Einträge
- Durchsucht alle `postData`-Felder in `sharedContext.requests`
- Gibt Treffer mit ±120 Zeichen Kontext-Snippets zurück
- Groß-/Kleinschreibung ignoriert

System-Prompt erweitert: "Sage NIEMALS 'ich kann die Inhalte nicht sehen' — nutze getResponseBody() oder searchInData()!"

---

## API-Key Verschlüsselung (Phase 8)

### Problem

`ai-key.json` enthielt API-Keys im Plaintext — sichtbar mit jedem Text-Editor.

### Lösung

`electron.safeStorage` nutzt OS-Keychain für Ver-/Entschlüsselung.
Nur die gleiche Electron-App + gleicher OS-User kann entschlüsseln.

Migration: Alter Plaintext-Key-File wurde gelöscht, neue verschlüsselte Datei wird beim ersten Speichern angelegt.

---

## UI-Verbesserungen (diverse)

### Copy-Buttons überall

Event-Delegation statt individueller Listener:
- Header-Werte: `.copy-val`-Klasse
- Body-Blöcke: `.copy-block-btn` innerhalb `.body-section`
- Code-Blöcke im AI-Chat: `.code-copy-btn` auf `<pre>`-Elementen

### Rainbow Typing Dots

6 Punkte in Pride-Farben (ROYGBV) mit versetzter CSS-Animation und Glow-Effekt.
`currentColor` in `text-shadow` erbt automatisch die per `:nth-child` gesetzte Farbe.

### Resizable Panels

Drag-Handle zwischen Tabellen-Pane und Detail-Pane. Min-Breite 200px.
