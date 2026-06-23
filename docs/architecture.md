# Architektur

## Prozess-Übersicht

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Main Process  (src/main.js)                           │
│                                                                 │
│  ┌────────────┐    WebSocket     ┌─────────────────────────┐   │
│  │  CDP-Client│◄────────────────►│  Chrome (Port 9222)     │   │
│  │  cdpSend() │                  │  DevTools Protocol      │   │
│  └─────┬──────┘                  └─────────────────────────┘   │
│        │ IPC                                                     │
│  ┌─────▼──────────────────────────────────────────────────┐    │
│  │  IPC Handler                                            │    │
│  │  cdp:*  browser:*  ai:*  shell:*                       │    │
│  └─────┬──────────┬──────────────────────────────────────-┘    │
└────────┼──────────┼────────────────────────────────────────────┘
         │ IPC      │ IPC
┌────────▼──┐  ┌────▼──────────────────────────────────────────┐
│ Preload   │  │ Preload AI  (src/preload-ai.js)               │
│ (preload  │  │ window.ai.{ getContext, getResponseBody,       │
│  .js)     │  │   searchBodies, saveKey, loadKey, browser.* } │
│ window.cdp│  └────┬──────────────────────────────────────────┘
└────┬──────┘       │
     │              │
┌────▼──────┐  ┌────▼──────────────────────────────────────────┐
│index.html │  │ ai-chat.html                                   │
│renderer.js│  │ ai-renderer.js                                 │
│  Network  │  │  Gemini / OpenAI Streaming                     │
│  Assets   │  │  Tool Calling (11 Tools)                       │
│  Debugger │  │  Context Pills                                  │
│  Console  │  └────────────────────────────────────────────────┘
│  API      │
└───────────┘
```

## Datei-Übersicht

| Datei | Zeilen | Zweck |
| --- | --- | --- |
| `src/main.js` | ~750 | Electron Main, CDP-WebSocket, IPC, Body-Cache, safeStorage |
| `src/renderer.js` | ~1520 | Haupt-UI: Network, Assets, API, Debugger, Console, JWT |
| `src/ai-renderer.js` | ~990 | AI-Chat: Gemini+OpenAI Streaming, Tool Calling, Context |
| `src/preload.js` | ~40 | Bridge für index.html → window.cdp.* |
| `src/preload-ai.js` | ~36 | Bridge für ai-chat.html → window.ai.* |
| `index.html` | ~600 | Haupt-UI HTML + alle CSS-Styles |
| `ai-chat.html` | ~450 | AI-Chat HTML + CSS (Dark Mode, Rainbow Dots) |

## Datenfluss: Network Request

```
Chrome Browser
  → Network.responseReceived  → requestInfoCache (mimeType + url)
  → Network.loadingFinished   → shouldCacheBody? → cdpSend(Network.getResponseBody)
                                                  → responseBodyCache.set(id, body)
  → cdp:network event         → renderer.js (UI update)
  → ai:updateContext          → sharedContext.requests[]
```

## Datenfluss: AI-Agent Anfrage

```
User tippt Prompt
  → sendMessage()
  → buildContext()  → activeCtx Pills → window.ai.getContext(type) → IPC → sharedContext
  → currentProvider === 'gemini' → runGeminiLoop()
  → currentProvider === 'openai' → runOpenAILoop()
  → streaming response → addAssistantBubble()
                       → content.textContent = bubbleText  (während Stream)
                       → content.innerHTML = markdownToHtml() (nach Stream-Ende)
  → Tool Call? → executeTool(name, args) → window.ai.getResponseBody / searchBodies
```

## Sicherheitsmodell

- `contextIsolation: true` — kein direkter Zugriff auf Node.js aus Renderer
- `nodeIntegration: false` — Renderer kann Node-APIs nicht direkt nutzen
- Nur explizit in Preload exponierte Funktionen sind aus Renderer erreichbar
- API-Keys verschlüsselt via `safeStorage` (macOS Keychain / Windows DPAPI)
- CDP-Verbindung nur zu `localhost:9222`
