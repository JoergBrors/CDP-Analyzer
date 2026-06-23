# AI Browser Analyst — Implementierungsdetails

## Übersicht

Der AI-Agent läuft in einem separaten Electron-Fenster (`ai-chat.html` + `src/ai-renderer.js`).
Er unterstützt Google Gemini und OpenAI als Backends mit vollständigem Streaming und Tool Calling.

---

## Provider-Konfiguration

```js
const PROVIDER_CONFIG = {
  gemini: {
    defaultModel: 'gemini-2.5-pro',
    keyLink: 'https://aistudio.google.com/app/apikey',
    // Modelle werden live von der API geladen (fetchGeminiModels)
  },
  openai: {
    defaultModel: 'gpt-4.1',
    keyLink: 'https://platform.openai.com/api-keys',
    // Filter: nur gpt-4/o1/o3/o4, kein instruct/audio/embedding
  },
};
```

State-Variablen:

```js
let currentProvider = 'gemini';   // 'gemini' | 'openai'
let currentModel    = 'gemini-2.5-pro';
let geminiHistory   = [];          // [{ role:'user'|'model', parts:[{text}] }]
let openaiMessages  = [];          // [{ role:'system'|'user'|'assistant', content }]
let activeCtx       = new Set();   // aktive Context-Pills
```

---

## Streaming-Architektur

### Problem das gelöst wurde

Streaming-Text darf NICHT mit einem Markdown-Parser verarbeitet werden während der Stream läuft.
Jedes Chunk als HTML würde: (a) `<p>` um jeden Chunk erzeugen, (b) den Cursor zerstören, (c) Wörter in Spalten darstellen.

### Lösung

```js
function addAssistantBubble() {
  // content und cursor sind GESCHWISTER, nicht verschachtelt
  const content = document.createElement('div');
  content.className = 'bubble-content';
  const cursor = document.createElement('span');
  cursor.className = 'typing-cursor';
  cursor.innerHTML = '<span class="typing-dot">●</span>'.repeat(6);
  bubble.appendChild(content);
  bubble.appendChild(cursor);   // cursor ist nach content, nicht darin
  return { content, cursor };
}

// Während Stream:
content.textContent = bubbleText;   // Plain text — kein HTML-Parsing

// Nach Stream (cursor.remove() wurde schon aufgerufen):
content.innerHTML = markdownToHtml(escHtml(bubbleText));
addCodeCopyButtons(content);
```

### Gemini Streaming (SSE)

Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`

```js
async function* streamGemini(body, apiKey) {
  const resp = await fetch(url, { method:'POST', body: JSON.stringify(body), headers:{...} });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE-Parsing: data: {...}\n\n
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = JSON.parse(line.slice(6));
      yield json;   // { candidates: [{ content: { parts }, finishReason }] }
    }
  }
}
```

Tool-Calls kommen als `parts[n].functionCall = { name, args }` im Candidate.

### OpenAI Streaming

Endpoint: `https://api.openai.com/v1/chat/completions` mit `stream: true`

Delta-Accumulation für Tool-Calls (können über mehrere Chunks verteilt sein):

```js
// In runOpenAILoop():
const toolCallAcc = {};  // index → { id, name, args }
for await (const chunk of streamOpenAI(payload, key)) {
  for (const delta of chunk.choices[0]?.delta?.tool_calls || []) {
    const tc = toolCallAcc[delta.index] || (toolCallAcc[delta.index] = { id:'', name:'', args:'' });
    if (delta.id)                    tc.id   += delta.id;
    if (delta.function?.name)        tc.name += delta.function.name;
    if (delta.function?.arguments)   tc.args += delta.function.arguments;
  }
}
```

---

## Tools

Alle 11 Tools sind in `GEMINI_TOOLS[0].functionDeclarations` definiert und via `convertParamsToOpenAI()` für OpenAI konvertiert.

| Tool | Zweck |
| --- | --- |
| `navigate(url)` | Chrome zu URL navigieren |
| `click(selector)` | DOM-Element klicken |
| `type(selector, text)` | Text eingeben |
| `evaluate(expression)` | JavaScript im Browser ausführen |
| `getPageContent()` | URL + Titel + sichtbarer Text |
| `screenshot()` | PNG-Screenshot (base64) |
| `reload()` | Seite neu laden |
| `scroll(x, y)` | Seite scrollen |
| `getCdpContext(type)` | CDP-Metadaten holen (api/network/errors/...) |
| `getResponseBody(requestId)` | Vollständiger Response-Body laden |
| `searchInData(query, maxResults?)` | Volltext-Suche in allen gecachten Bodies |

### Tool-Ausführungs-Loop (Agentic)

```
User Message
  → build messages/history with system prompt + context
  → API call (streaming)
  → text chunks → stream to bubble
  → tool_call? → executeTool(name, args)
              → append tool result to history
              → loop: API call again
  → finish → render markdown
```

Max Iterationen: 12 (Schutz vor Endlosschleife).

---

## Kontext-Aufbereitung (`buildContext()`)

Wenn `activeCtx.has('api')`: JWT-Tokens werden decodiert bevor sie an die KI gesendet werden.

```js
// Bearer-Token decodieren:
if (v.toLowerCase().startsWith('bearer ')) {
  const payload = b64decode(token.split('.')[1]);
  const slim = { name, upn, tid, oid, appid, scp, roles, exp, aud, iss };
  // expired? → "JWT ABGELAUFEN" Markierung
}
```

Dies verhindert dass der rohe Token (mit Signaturteil) an externe KI-APIs gesendet wird.

---

## Kontext-Typen (Pills)

| Pill | `activeCtx` Key | Was gesendet wird |
| --- | --- | --- |
| 📡 API Requests | `'api'` | 50 Requests + JWT-Payloads + `hasBody` flag |
| 🌐 Network | `'network'` | 50 Requests (Metadaten) |
| 🔴 Fehler | `'errors'` | HTTP-Fehler + fehlgeschlagene Requests |
| 📄 Scripts | `'scripts'` | Geladene JS-Dateien |
| ⏸ Debugger | `'paused'` | Pause-State + Call Stack |
| ⬛ Console | `'console'` | Letzte 30 Console-Einträge |

---

## System-Prompt Struktur

```
Rolle + Kontext-Typen-Beschreibung
Tools:
  - getCdpContext(type)      → Metadaten
  - getResponseBody(id)      → vollständiger Body
  - searchInData(query)      → Volltext-Suche
  - navigate/click/...       → Browser-Steuerung
Workflow: getCdpContext → getResponseBody/searchInData
KRITISCH: NIEMALS sagen "ich kann nicht sehen" → stattdessen Tool nutzen
```

---

## Chat-Verlauf

Separate Historien pro Provider werden bei Provider-Wechsel nicht vermischt:

```js
// Gemini:
geminiHistory.push({ role:'user', parts:[{text: userMsg + context}] });
geminiHistory.push({ role:'model', parts:[{text: assistantReply}] });

// OpenAI:
openaiMessages.push({ role:'user', content: userMsg + context });
openaiMessages.push({ role:'assistant', content: assistantReply });
```

Beschneidung: max 10 Turns (`MAX_HISTORY_TURNS`). System-Message bleibt immer erhalten.

---

## Rainbow Typing Indicator

6 Punkte in ROYGBV-Farben mit versetzter Animation:

```css
.typing-dot:nth-child(1) { color: #FF3B30; animation-delay: 0s;   }
.typing-dot:nth-child(2) { color: #FF9500; animation-delay: .17s; }
.typing-dot:nth-child(3) { color: #FFD60A; animation-delay: .34s; }
.typing-dot:nth-child(4) { color: #30D158; animation-delay: .51s; }
.typing-dot:nth-child(5) { color: #0A84FF; animation-delay: .68s; }
.typing-dot:nth-child(6) { color: #BF5AF2; animation-delay: .85s; }

@keyframes pride-pulse {
  0%,100% { opacity:.12; transform:scale(.7) translateY(0); text-shadow:none; }
  45%     { opacity:1; transform:scale(1.35) translateY(-3px);
            text-shadow: 0 0 5px currentColor, 0 0 12px currentColor, 0 0 24px currentColor; }
}
```

`currentColor` sorgt dafür dass `text-shadow` automatisch die per `:nth-child` gesetzte Farbe übernimmt.
