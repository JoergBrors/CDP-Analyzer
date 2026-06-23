# CDP Analyzer — Dokumentations-Index

Alle Dokumente für die Weiterentwicklung.

---

## Dokumente

| Datei | Inhalt |
| --- | --- |
| [architecture.md](architecture.md) | Prozess-Übersicht, Datei-Struktur, Datenflüsse, Sicherheitsmodell |
| [ipc-api.md](ipc-api.md) | Vollständige IPC-Referenz: alle `window.cdp.*` und `window.ai.*` Methoden mit Signaturen |
| [network-capture.md](network-capture.md) | CDP Network Domain, Worker-Tracking, Deep Intercept, Body-Cache, API-Erkennung |
| [ai-agent.md](ai-agent.md) | AI-Chat-Implementierung: Streaming, Tool Calling, Context Pills, System-Prompt |
| [jwt-auth.md](jwt-auth.md) | JWT-Dekodierung, Auth-Erkennung, Microsoft Entra ID Claims, UI-Darstellung |
| [ui-renderer.md](ui-renderer.md) | Panel-Struktur, Copy-Buttons, Batch-Darstellung, JSON-Formatierung, CSS-Architektur |
| [security.md](security.md) | safeStorage-Verschlüsselung, Electron-Sicherheitsmodell, was an externe APIs gesendet wird |
| [dev-history.md](dev-history.md) | Chronologischer Entwicklungsverlauf: was warum wie implementiert wurde, alle Bug-Fixes |
| [known-issues.md](known-issues.md) | Aktuelle Limitierungen, fixe Bugs als Referenz, potenzielle Erweiterungen |

---

## Schnell-Orientierung

**Neue IPC-Methode hinzufügen:**
1. `src/main.js` → `ipcMain.handle('kanal:name', ...)` implementieren
2. `src/preload.js` oder `src/preload-ai.js` → in `contextBridge.exposeInMainWorld` eintragen
3. In Renderer nutzen: `window.cdp.name()` oder `window.ai.name()`
→ Details: [ipc-api.md](ipc-api.md)

**Neues AI-Tool hinzufügen:**
1. `GEMINI_TOOLS[0].functionDeclarations` → Tool-Definition (wird automatisch zu OpenAI konvertiert)
2. `executeTool()` → `case 'toolName':` hinzufügen
3. System-Prompt in `buildSystemPrompt()` aktualisieren
→ Details: [ai-agent.md](ai-agent.md)

**API-Erkennung erweitern:**
- `src/main.js`: `API_RE` / `HOST_RE` in `ai:getContext('api')`
- `src/renderer.js`: `API_PATH_RE` / `API_HOST_RE` für das API-Panel
- `src/main.js`: `API_URL_RE` für den Body-Cache
→ Details: [network-capture.md](network-capture.md)

**Neuen Kontext-Typ fürs AI hinzufügen:**
1. `src/main.js`: neuer `case` in `ipcMain.handle('ai:getContext', ...)`
2. `ai-chat.html`: neue `.ctx-pill[data-ctx="name"]` hinzufügen
3. `src/ai-renderer.js`: `buildContext()` um den neuen Typ erweitern, `CDP_CTX_TOOL_DESC` aktualisieren
→ Details: [ai-agent.md](ai-agent.md)

---

## Technologie-Stack

```
Electron 30       — Desktop-App, Main/Renderer-Prozesse, safeStorage
Chrome DevTools Protocol — WebSocket, JSON-RPC
Google Gemini API — streamGenerateContent?alt=sse (SSE)
OpenAI API        — chat/completions mit stream:true
Node.js http/ws   — CDP-Connection, HTTP-Requests für Target-Liste
Vanilla JS/CSS    — kein Framework, kein Build-Step
```

---

## Starten

```bash
# App starten:
npm start

# Optionaler manueller Chrome-Start mit Debug-Port:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/ChromeDebug
```
