// src/ai-renderer.js — AI Chat Fenster Renderer
'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let geminiHistory         = [];   // Gemini-Format: { role:'user'|'model', parts:[{text}] }
let openaiMessages        = [];   // OpenAI-Format:  { role:'user'|'assistant', content }
let activeCtx             = new Set();
let isStreaming            = false;
let currentProvider        = 'gemini';   // 'gemini' | 'openai'
let currentModel           = 'gemini-2.5-pro';
let browserControlEnabled  = false;
let lastContextHash        = '';
let lastKeyStatusMsg       = { cls: 'ok', msg: '' };

// ── Helpers ──────────────────────────────────────────────────────────────────
const MAX_HISTORY_TURNS = 10;

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
function pruneGemini(h) {
  return h.length > MAX_HISTORY_TURNS ? h.slice(-MAX_HISTORY_TURNS) : h;
}
function pruneOpenAI(msgs) {
  // Systemzeit behalten, dann die letzten N User/Assistant-Paare
  const sys = msgs.filter(m => m.role === 'system');
  const rest = msgs.filter(m => m.role !== 'system');
  const keep = rest.length > MAX_HISTORY_TURNS ? rest.slice(-MAX_HISTORY_TURNS) : rest;
  return [...sys, ...keep];
}
function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// ── Provider-Konfiguration ───────────────────────────────────────────────────
const PROVIDER_CONFIG = {
  gemini: {
    label: 'AI Studio Key:',
    placeholder: 'AIza…',
    keyLink: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.5-pro',
    fallbackModels: [
      ['gemini-2.5-pro',        'Gemini 2.5 Pro'],
      ['gemini-2.0-flash',      'Gemini 2.0 Flash'],
      ['gemini-1.5-pro',        'Gemini 1.5 Pro'],
      ['gemini-1.5-flash',      'Gemini 1.5 Flash'],
    ],
  },
  openai: {
    label: 'OpenAI API Key:',
    placeholder: 'sk-…',
    keyLink: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4.1',
    fallbackModels: [
      ['gpt-4.1',        'GPT-4.1 (neuestes)'],
      ['gpt-4.1-mini',   'GPT-4.1 Mini (schnell)'],
      ['gpt-4.1-nano',   'GPT-4.1 Nano (günstig)'],
      ['gpt-4o',         'GPT-4o'],
      ['gpt-4o-mini',    'GPT-4o Mini'],
      ['o3',             'o3 (Reasoning)'],
      ['o4-mini',        'o4-mini (Reasoning, schnell)'],
    ],
  },
};

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const data = await window.ai.loadKey();
  if (data && typeof data === 'object') {
    const geminiKey = data.keys?.gemini || data.key || null;
    const openaiKey = data.keys?.openai || null;
    if (geminiKey) {
      document.getElementById('api-key-input').value = geminiKey;
      setKeyStatus('ok', '✓ Key geladen');
      await fetchAndPopulateModels(geminiKey);
    }
    // OpenAI-Key im State merken, aber UI zeigt aktuell Gemini
    if (openaiKey) window._openaiKeyCache = openaiKey;
  }
})();

// ── Provider-Wechsel ─────────────────────────────────────────────────────────
document.getElementById('provider-select').addEventListener('change', async (e) => {
  const prov = e.target.value;
  if (prov === currentProvider) return;
  currentProvider = prov;

  const cfg = PROVIDER_CONFIG[prov];
  document.getElementById('key-label').textContent = cfg.label;
  document.getElementById('api-key-input').placeholder = cfg.placeholder;
  document.getElementById('api-key-input').value = '';
  document.getElementById('key-link').title = cfg.keyLink;
  document.getElementById('key-link').onclick = () => { window.ai.openExternal?.(cfg.keyLink); return false; };

  const badge = document.getElementById('provider-badge');
  badge.textContent = prov === 'gemini' ? 'Gemini' : 'OpenAI';
  badge.className = `provider-badge ${prov}`;

  // Key für neuen Provider laden
  const savedKey = await window.ai.loadKey(prov) || window[`_${prov}KeyCache`] || null;
  if (savedKey) {
    document.getElementById('api-key-input').value = savedKey;
    setKeyStatus('ok', '✓ Key geladen');
    await fetchAndPopulateModels(savedKey);
  } else {
    document.getElementById('model-select').innerHTML = cfg.fallbackModels
      .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    currentModel = cfg.defaultModel;
    document.getElementById('model-display').textContent = currentModel;
    setKeyStatus('', '');
  }

  // Chat-Verlauf trennen per Provider
  clearChatUI('Gewechselt zu ' + (prov === 'openai' ? 'OpenAI' : 'Google Gemini') + '. Neuer Chat.');
});

// ── Key-Link ─────────────────────────────────────────────────────────────────
document.getElementById('key-link').addEventListener('click', () => {
  const url = PROVIDER_CONFIG[currentProvider].keyLink;
  window.open ? window.open(url) : window.location.href = url;
  return false;
});

// ── Modell-Auswahl ────────────────────────────────────────────────────────────
document.getElementById('model-select').addEventListener('change', (e) => {
  currentModel = e.target.value;
  document.getElementById('model-display').textContent = currentModel;
});

// ── API-Key speichern ─────────────────────────────────────────────────────────
document.getElementById('btn-save-key').addEventListener('click', async () => {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) return;
  window[`_${currentProvider}KeyCache`] = key;
  const res = await window.ai.saveKey(currentProvider, key);
  setKeyStatus(res.ok ? 'ok' : 'err', res.ok ? '✓ Gespeichert' : '✗ ' + res.error);
  if (res.ok) await fetchAndPopulateModels(key);
});

// ── Modelle laden ─────────────────────────────────────────────────────────────
async function fetchAndPopulateModels(apiKey) {
  const select = document.getElementById('model-select');
  const display = document.getElementById('model-display');
  select.disabled = true;
  select.innerHTML = '<option value="">⏳ Lade Modelle…</option>';

  try {
    const models = currentProvider === 'gemini'
      ? await fetchGeminiModels(apiKey)
      : await fetchOpenAIModels(apiKey);

    select.innerHTML = models.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

    const cfg = PROVIDER_CONFIG[currentProvider];
    const preferred = cfg.defaultModel;
    if ([...select.options].some(o => o.value === preferred)) select.value = preferred;
    else if (!select.value) select.selectedIndex = 0;

    currentModel = select.value;
    display.textContent = currentModel;
    setKeyStatus('ok', `✓ ${models.length} Modelle geladen`);
  } catch (err) {
    const cfg = PROVIDER_CONFIG[currentProvider];
    select.innerHTML = cfg.fallbackModels
      .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    select.value = cfg.defaultModel;
    currentModel = select.value;
    display.textContent = currentModel;
    setKeyStatus('err', `✗ ${err.message.slice(0, 50)}`);
  } finally {
    select.disabled = false;
  }
}

async function fetchGeminiModels(apiKey) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .sort((a, b) => b.name.localeCompare(a.name))   // neueste zuerst
    .map(m => [m.name.replace(/^models\//, ''), m.displayName || m.name.replace(/^models\//, '')]);
}

async function fetchOpenAIModels(apiKey) {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const KEEP = /^(gpt-4|gpt-3\.5|o1|o3|o4)/;
  const SKIP = /instruct|realtime|audio|tts|whisper|dall-e|embed|babbage|davinci|curie/;
  return (data.data || [])
    .filter(m => KEEP.test(m.id) && !SKIP.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id))
    .map(m => [m.id, m.id]);
}

function setKeyStatus(cls, msg, persist = true) {
  const el = document.getElementById('key-status');
  el.className = cls;
  el.textContent = msg;
  if (persist) lastKeyStatusMsg = { cls, msg };
}

// ── Context-Pills ─────────────────────────────────────────────────────────────
document.querySelectorAll('.ctx-pill[data-ctx]').forEach(pill => {
  pill.addEventListener('click', () => {
    const ctx = pill.dataset.ctx;
    if (activeCtx.has(ctx)) {
      activeCtx.delete(ctx);
      pill.className = 'ctx-pill';
    } else {
      activeCtx.add(ctx);
      pill.className = `ctx-pill active-${ctx}`;
    }
  });
});

// Browser-Steuerungs-Toggle
document.getElementById('toggle-browser-ctrl').addEventListener('click', () => {
  browserControlEnabled = !browserControlEnabled;
  const btn = document.getElementById('toggle-browser-ctrl');
  btn.className = browserControlEnabled ? 'ctx-pill active-browser' : 'ctx-pill';
  addSystemMsg(browserControlEnabled
    ? '🖱 Browser-Steuerung aktiv — der Agent kann Chrome navigieren, klicken, tippen und JS ausführen.'
    : '🖱 Browser-Steuerung deaktiviert.');
});

// Quick-Prompts
document.querySelectorAll('.qp').forEach(qp => {
  qp.addEventListener('click', () => {
    document.getElementById('msg-input').value = qp.dataset.prompt;
    sendMessage();
  });
});

document.addEventListener('wheel', (e) => {
  const area = document.getElementById('chat-area');
  if (area && !area.contains(e.target)) {
    e.preventDefault();
    area.scrollTop += e.deltaY;
  }
}, { passive: false });

// Clear Chat
document.getElementById('btn-clear-chat').addEventListener('click', () => clearChatUI());

function clearChatUI(msg = 'Chat geleert. Kontext und Verlauf zurückgesetzt.') {
  geminiHistory = [];
  openaiMessages = [];
  lastContextHash = '';
  document.getElementById('chat-area').innerHTML = `
    <div class="msg system-msg">
      <div class="msg-bubble">✦ ${escHtml(msg)}</div>
    </div>`;
}

// Input-Handling
const msgInput = document.getElementById('msg-input');
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
});
document.getElementById('btn-send').addEventListener('click', sendMessage);

// ── Gemini Function-Calling Tools ─────────────────────────────────────────────
const CDP_CTX_TOOL_DESC = `Liest Metadaten aus dem CDP-Analysator.
Typen:
  "api"      → letzte 50 API-Requests mit id, URL, Methode, Status, Headers, postData, hasBody
  "network"  → letzte 50 HTTP-Requests (URL, Methode, Status, Typ, Größe, Zeit)
  "errors"   → HTTP-Fehler (4xx/5xx) und fehlgeschlagene Requests
  "scripts"  → alle geladenen JavaScript-Dateien
  "console"  → letzte 30 Console-Ausgaben
  "paused"   → aktueller Debugger-Pause-Zustand
HINWEIS: Für Inhalte (Response-Body) getResponseBody(id) oder searchInData(query) verwenden.`;

const GEMINI_TOOLS = [{
  functionDeclarations: [
    { name: 'navigate', description: 'Navigiert Chrome zu einer URL',
      parameters: { type:'OBJECT', properties:{ url:{type:'STRING'} }, required:['url'] } },
    { name: 'click', description: 'Klickt auf ein DOM-Element per CSS-Selektor',
      parameters: { type:'OBJECT', properties:{ selector:{type:'STRING'} }, required:['selector'] } },
    { name: 'type', description: 'Gibt Text in ein Eingabefeld ein',
      parameters: { type:'OBJECT', properties:{ selector:{type:'STRING'}, text:{type:'STRING'} }, required:['selector','text'] } },
    { name: 'evaluate', description: 'Führt einen JavaScript-Ausdruck im Browser aus',
      parameters: { type:'OBJECT', properties:{ expression:{type:'STRING'} }, required:['expression'] } },
    { name: 'getPageContent', description: 'Gibt URL, Titel und sichtbaren Text der Seite zurück',
      parameters: { type:'OBJECT', properties:{}, required:[] } },
    { name: 'screenshot', description: 'Erstellt einen Screenshot der aktuellen Seite',
      parameters: { type:'OBJECT', properties:{}, required:[] } },
    { name: 'reload', description: 'Lädt die aktuelle Seite neu',
      parameters: { type:'OBJECT', properties:{}, required:[] } },
    { name: 'scroll', description: 'Scrollt die Seite',
      parameters: { type:'OBJECT', properties:{ x:{type:'NUMBER'}, y:{type:'NUMBER'} }, required:['x','y'] } },
    { name: 'getCdpContext', description: CDP_CTX_TOOL_DESC,
      parameters: { type:'OBJECT', properties:{ type:{type:'STRING'} }, required:['type'] } },
    { name: 'getResponseBody',
      description: 'Lädt den vollständigen Response-Body eines API-Requests anhand seiner ID. Die ID kommt aus getCdpContext("api")[n].id. Verwende dies um Batch-Response-Inhalte, JSON-Daten und Suchobjekte zu lesen.',
      parameters: { type:'OBJECT', properties:{ requestId:{type:'STRING'} }, required:['requestId'] } },
    { name: 'searchInData',
      description: 'Durchsucht ALLE gecachten Request- und Response-Bodies nach einem Begriff. Gibt Treffer mit Kontext-Snippets zurück. Nutze dies um Begriffe wie "agent", "displayName", "bot" oder Benutzer-Namen in den gesammelten API-Daten zu finden — OHNE dass du die IDs kennen musst.',
      parameters: { type:'OBJECT', properties:{
        query:      { type:'STRING', description:'Suchbegriff (min. 2 Zeichen, Groß-/Kleinschreibung ignoriert)' },
        maxResults: { type:'NUMBER', description:'Maximale Trefferzahl (default: 8)' },
      }, required:['query'] } },
  ],
}];

// OpenAI-Format (snake_case types)
const OPENAI_TOOLS = GEMINI_TOOLS[0].functionDeclarations.map(f => ({
  type: 'function',
  function: {
    name: f.name,
    description: f.description,
    parameters: convertParamsToOpenAI(f.parameters),
  },
}));

function convertParamsToOpenAI(p) {
  if (!p) return { type: 'object', properties: {}, required: [] };
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(p.properties || {}).map(([k, v]) => [k, { type: v.type.toLowerCase() }])
    ),
    required: p.required || [],
  };
}

// ── Tool-Ausführung (gemeinsam für beide Provider) ────────────────────────────
async function executeTool(name, args) {
  switch (name) {
    case 'navigate':
      return await window.ai.browser.navigate(args.url);
    case 'click': {
      const sel = JSON.stringify(args.selector);
      return await window.ai.browser.evaluate(
        `(()=>{const el=document.querySelector(${sel});if(!el)return{ok:false,error:'Nicht gefunden: '+${sel}};el.click();return{ok:true};})()`
      );
    }
    case 'type': {
      const sel = JSON.stringify(args.selector), txt = JSON.stringify(args.text);
      return await window.ai.browser.evaluate(
        `(()=>{const el=document.querySelector(${sel});if(!el)return{ok:false,error:'Nicht gefunden: '+${sel}};el.focus();el.value=${txt};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true};})()`
      );
    }
    case 'evaluate':
      return await window.ai.browser.evaluate(args.expression);
    case 'getPageContent':
      return await window.ai.browser.getContent();
    case 'screenshot':
      return await window.ai.browser.screenshot();
    case 'reload':
      return await window.ai.browser.reload();
    case 'scroll':
      return await window.ai.browser.evaluate(
        `window.scrollBy(${Number(args.x)||0},${Number(args.y)||0});'ok'`
      );
    case 'getCdpContext': {
      const allowed = ['api','network','errors','scripts','console','paused'];
      if (!allowed.includes(args.type)) return { ok:false, error:`Ungültig: ${args.type}` };
      const res = await window.ai.getContext(args.type);
      if (!res?.ok) return { ok:false, error: res?.error || 'CDP nicht verbunden' };
      if (!res.data || (Array.isArray(res.data) && !res.data.length))
        return { ok:true, type:args.type, data:[], note:'Keine Daten vorhanden' };
      return { ok:true, type:args.type, data:res.data };
    }
    case 'getResponseBody': {
      if (!args.requestId) return { ok:false, error:'requestId fehlt' };
      const res = await window.ai.getResponseBody(args.requestId);
      if (!res?.ok) return { ok:false, error: res?.error || 'Body nicht verfügbar' };
      // JSON pretty-print falls möglich
      let body = res.body || '';
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      return { ok:true, requestId:args.requestId, bodySize:body.length, body };
    }
    case 'searchInData': {
      if (!args.query) return { ok:false, error:'query fehlt' };
      const res = await window.ai.searchBodies(args.query, args.maxResults || 8);
      if (!res?.ok) return { ok:false, error: res?.error || 'Suche fehlgeschlagen' };
      return res;
    }
    default:
      return { ok:false, error:`Unbekannte Funktion: ${name}` };
  }
}

// ── Kontext zusammenbauen ─────────────────────────────────────────────────────
async function buildContext() {
  if (!activeCtx.size) return null;
  const parts = [];

  if (activeCtx.has('api')) {
    const res = await window.ai.getContext('api');
    if (res?.ok && res.data?.length) {
      const rows = res.data.map(r => {
        const hdrs = Object.entries(r.requestHeaders || {})
          .filter(([k]) => /auth|bearer|token|cookie|key|api/i.test(k))
          .map(([k, v]) => {
            // Bearer JWT → decodierten Payload senden, nicht rohen Token
            if (/^authorization$/i.test(k) && v.toLowerCase().startsWith('bearer ')) {
              const parts = v.slice(7).split('.');
              if (parts.length === 3) {
                try {
                  const b64 = s => JSON.parse(atob(s.replace(/-/g,'+').replace(/_/g,'/')));
                  const payload = b64(parts[1]);
                  const keep = ['name','upn','preferred_username','email','sub','oid','tid',
                                'appid','azp','scp','scope','roles','aud','iss','exp','iat','ver'];
                  const slim = Object.fromEntries(keep.filter(f=>payload[f]!==undefined).map(f=>[f,payload[f]]));
                  const expStr = slim.exp ? new Date(slim.exp*1000).toISOString() : '';
                  const expired = slim.exp && Date.now()/1000 > slim.exp;
                  return `  Authorization: Bearer <JWT${expired?' ABGELAUFEN':''}>\n  JWT-Payload: ${JSON.stringify(slim, null, 2).split('\n').map((l,i)=>i?'    '+l:l).join('\n')}${expStr?`\n  exp-human: ${expStr}`:''}`;
                } catch {}
              }
            }
            return `  ${k}: ${v.slice(0, 120)}`;
          }).join('\n');

        // Batch-Requests ausklappen: Sub-Requests einzeln zeigen
        let batchSection = '';
        if (r.isBatch && r.postData) {
          try {
            const b = JSON.parse(r.postData);
            const subs = b.requests || (Array.isArray(b) ? b : null);
            if (subs?.length) {
              batchSection = `\n  BATCH (${subs.length} Sub-Requests, asynchron verarbeitet):\n` +
                subs.map((sr, i) => {
                  const body = sr.body ? '\n      Body: ' + JSON.stringify(sr.body).slice(0, 400) : '';
                  const dep  = sr.dependsOn?.length ? ` [dependsOn: ${sr.dependsOn.join(',')}]` : '';
                  return `    [${sr.id ?? i+1}] ${sr.method} ${sr.url}${dep}${body}`;
                }).join('\n');
            }
          } catch {}
        }

        return `[${r.method}] ${r.status||'?'} ${r.url}\n  MIME:${r.mime||'?'} Size:${r.size||0}B Time:${r.timeMs?Math.round(r.timeMs)+'ms':'-'}${hdrs?'\n  Auth-Headers:\n'+hdrs:''}${batchSection}${!batchSection && r.postData?'\n  Body: '+r.postData.slice(0,400):''}`;
      }).join('\n---\n');
      parts.push(`=== API REQUESTS (letzte ${res.data.length}) ===\n${rows}`);
    }
  }

  if (activeCtx.has('network')) {
    const res = await window.ai.getContext('network');
    if (res?.ok && res.data?.length) {
      const rows = res.data.slice(-50).map(r =>
        `[${r.method}] ${r.status||'?'} ${r.type||'?'} ${r.url} — ${r.size||0}B ${r.timeMs?Math.round(r.timeMs)+'ms':''} initiator:${r.initiatorType||'?'}`
      ).join('\n');
      parts.push(`=== NETWORK REQUESTS (letzte ${res.data.slice(-50).length}) ===\n${rows}`);
    }
  }

  if (activeCtx.has('errors')) {
    const res = await window.ai.getContext('errors');
    if (res?.ok && res.data?.length) {
      parts.push(`=== FEHLER ===\n${res.data.map(r=>
        `${r.status||'FAIL'} ${r.method} ${r.url}${r.errorText?' → '+r.errorText:''}`
      ).join('\n')}`);
    }
  }

  if (activeCtx.has('scripts')) {
    const res = await window.ai.getContext('scripts');
    if (res?.ok && res.data?.length)
      parts.push(`=== SCRIPTS (${res.data.length}) ===\n${res.data.map(s=>s.url||s.scriptId).join('\n')}`);
  }

  if (activeCtx.has('paused')) {
    const res = await window.ai.getContext('paused');
    if (res?.ok && res.data)
      parts.push(`=== DEBUGGER PAUSE ===\n${JSON.stringify(res.data, null, 2)}`);
  }

  if (activeCtx.has('console')) {
    const res = await window.ai.getContext('console');
    if (res?.ok && res.data?.length)
      parts.push(`=== CONSOLE (letzte ${Math.min(res.data.length,30)}) ===\n${res.data.slice(-30).map(e=>`[${e.type}] ${e.text}`).join('\n')}`);
  }

  return parts.length ? parts.join('\n\n') : null;
}

// ── System-Prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(withTools) {
  const toolSection = withTools ? `
BROWSER-STEUERUNG AKTIV. Du hast folgende Werkzeuge und MUSST sie einsetzen:
- navigate(url)           → Chrome zu URL navigieren
- click(selector)         → Element klicken
- type(selector, text)    → Text eingeben
- evaluate(expression)    → JavaScript ausführen
- getPageContent()        → Seiteninhalt lesen
- screenshot()            → Screenshot erstellen
- reload()                → Seite neu laden
- scroll(x, y)            → Seite scrollen

CDP-Daten lesen (BEVORZUGE diese vor "ich kann nicht..."):
- getCdpContext("api")     → API-Requests mit id, URL, Methode, Status, Headers, postData, hasBody
- getCdpContext("network") → Alle HTTP-Requests
- getCdpContext("errors")  → HTTP-Fehler
- getCdpContext("scripts") → Geladene Scripts
- getCdpContext("console") → Console-Ausgaben
- getCdpContext("paused")  → Debugger-Pause
- getResponseBody(id)      → Vollständiger Response-Body eines Requests (id aus getCdpContext("api"))
- searchInData(query)      → Sucht in ALLEN gecachten Requests/Responses nach einem Begriff — gibt Treffer mit Kontext zurück

WORKFLOW für Inhaltsanalyse:
1. getCdpContext("api") → sieh dir die Requests an, notiere die IDs der interessanten
2. getResponseBody(id)  → lade den vollen Response-Body für jeden interessanten Request
3. ODER: searchInData("suchbegriff") → suche direkt über alle Daten ohne IDs zu kennen

KRITISCH:
- Sage NIEMALS "ich kann die Inhalte nicht sehen" — nutze getResponseBody() oder searchInData()!
- Führe Aktionen direkt aus ohne zu fragen.
` : '';

  return `Du bist ein erfahrener Web-Entwickler und Browser-Analyst.
Du analysierst CDP-Daten (Chrome DevTools Protocol) aus einem laufenden Browser.
${toolSection}
Antworte immer auf Deutsch, präzise und handlungsorientiert.
Nutze Code-Blöcke (\`\`\`) für konkrete Beispiele.
Bei API-Requests: zeige Endpoints, Auth-Methoden, auffällige Muster und mögliche Sicherheitsprobleme.`;
}

// ── Nachricht senden ──────────────────────────────────────────────────────────
async function sendMessage() {
  if (isStreaming) return;
  const text = msgInput.value.trim();
  if (!text) return;
  const apiKey = document.getElementById('api-key-input').value.trim();
  if (!apiKey) { addSystemMsg('⚠ Bitte zuerst den API-Key eingeben und speichern.'); return; }

  msgInput.value = '';
  msgInput.style.height = 'auto';

  const ctxText  = await buildContext();
  const ctxPills = ctxText ? [...activeCtx] : null;
  addMsg('user', text, ctxPills);

  const ctxHash   = ctxText ? hashStr(ctxText) : '';
  const wasPruned = currentProvider === 'gemini'
    ? geminiHistory.length >= MAX_HISTORY_TURNS
    : openaiMessages.filter(m=>m.role!=='system').length >= MAX_HISTORY_TURNS;
  const sendCtx = ctxText && (ctxHash !== lastContextHash || wasPruned);
  if (sendCtx) lastContextHash = ctxHash;

  const sysPrompt  = buildSystemPrompt(browserControlEnabled);
  const tools      = browserControlEnabled
    ? (currentProvider === 'gemini' ? GEMINI_TOOLS : OPENAI_TOOLS)
    : null;

  isStreaming = true;
  setBtnState(true);
  const estMsg = currentProvider === 'gemini'
    ? pruneGemini(geminiHistory)
    : pruneOpenAI(openaiMessages);
  setKeyStatus('ok', `⬆ ~${estimateTokens(estMsg).toLocaleString()} Tokens`, false);

  try {
    if (currentProvider === 'gemini') {
      await runGeminiLoop(apiKey, text, ctxText, sendCtx, sysPrompt, tools);
    } else {
      await runOpenAILoop(apiKey, text, ctxText, sendCtx, sysPrompt, tools);
    }
  } catch (err) {
    const isOverload = RETRYABLE.test(err.message);
    addSystemMsg(isOverload
      ? `⚠ Modell überlastet — bitte erneut probieren oder anderes Modell wählen.`
      : `✗ Fehler: ${escHtml(err.message)}`);
  }

  isStreaming = false;
  setBtnState(false);
  setKeyStatus(lastKeyStatusMsg.cls, lastKeyStatusMsg.msg);
}

// ── Gemini Agentenloop ────────────────────────────────────────────────────────
async function runGeminiLoop(apiKey, userText, ctxText, sendCtx, sysPrompt, tools) {
  const userParts = [];
  if (sendCtx && ctxText) userParts.push({ text: `<browser_data>\n${ctxText}\n</browser_data>\n\n` });
  else if (ctxText)        userParts.push({ text: '[Kontext unverändert]\n\n' });
  userParts.push({ text: userText });
  geminiHistory.push({ role:'user', parts: userParts });

  let iterations = 0;
  while (iterations++ < 10) {
    const { content, cursor } = addAssistantBubble();
    let bubbleText = '';

    const functionCalls = await streamGeminiWithRetry(
      apiKey, pruneGemini(geminiHistory), currentModel, sysPrompt,
      chunk => {
        bubbleText += chunk;
        content.textContent = bubbleText;   // reiner Text beim Streamen
        scrollToBottom();
      },
      tools,
      status => { cursor.innerHTML = status
        ? `<span style="color:var(--yellow);font-size:11px">${escHtml(status)}</span>`
        : '<span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span>'; }
    );
    cursor.remove();
    content.innerHTML = markdownToHtml(escHtml(bubbleText)); // einmaliges Markdown-Render
    addCodeCopyButtons(content);

    if (!functionCalls.length) {
      geminiHistory.push({ role:'model', parts:[{ text: bubbleText }] });
      break;
    }
    const modelParts = [];
    if (bubbleText.trim()) modelParts.push({ text: bubbleText });
    functionCalls.forEach(fc => modelParts.push({ functionCall: fc }));
    geminiHistory.push({ role:'model', parts: modelParts });

    const funcResponseParts = [];
    for (const fc of functionCalls) {
      const toolDiv = addToolCallBubble(fc.name, fc.args||{});
      const result  = await executeTool(fc.name, fc.args||{});
      updateToolCallResult(toolDiv, result);
      if (fc.name === 'screenshot' && result?.ok && result.data) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${result.data}`;
        toolDiv.querySelector('.msg-bubble').appendChild(img);
        scrollToBottom();
      }
      funcResponseParts.push({ functionResponse: { name: fc.name, response: result || {ok:true} } });
    }
    geminiHistory.push({ role:'user', parts: funcResponseParts });
  }
}

// ── OpenAI Agentenloop ────────────────────────────────────────────────────────
async function runOpenAILoop(apiKey, userText, ctxText, sendCtx, sysPrompt, tools) {
  // System-Message (immer aktuell halten)
  openaiMessages = openaiMessages.filter(m => m.role !== 'system');
  openaiMessages.unshift({ role:'system', content: sysPrompt });

  let content = '';
  if (sendCtx && ctxText) content = `<browser_data>\n${ctxText}\n</browser_data>\n\n`;
  else if (ctxText)        content = '[Kontext unverändert]\n\n';
  content += userText;
  openaiMessages.push({ role:'user', content });

  let iterations = 0;
  while (iterations++ < 10) {
    const { content, cursor } = addAssistantBubble();
    let bubbleText = '';

    const toolCalls = await streamOpenAIWithRetry(
      apiKey, pruneOpenAI(openaiMessages), currentModel,
      chunk => {
        bubbleText += chunk;
        content.textContent = bubbleText;   // reiner Text beim Streamen
        scrollToBottom();
      },
      tools,
      status => { cursor.innerHTML = status
        ? `<span style="color:var(--yellow);font-size:11px">${escHtml(status)}</span>`
        : '<span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span>'; }
    );
    cursor.remove();
    content.innerHTML = markdownToHtml(escHtml(bubbleText)); // einmaliges Markdown-Render
    addCodeCopyButtons(content);

    if (!toolCalls.length) {
      openaiMessages.push({ role:'assistant', content: bubbleText });
      break;
    }

    // Assistant-Nachricht mit Tool-Calls speichern
    openaiMessages.push({ role:'assistant', content: bubbleText || null, tool_calls: toolCalls });

    // Tools ausführen
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      const toolDiv = addToolCallBubble(tc.function.name, args);
      const result  = await executeTool(tc.function.name, args);
      updateToolCallResult(toolDiv, result);
      if (tc.function.name === 'screenshot' && result?.ok && result.data) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${result.data}`;
        toolDiv.querySelector('.msg-bubble').appendChild(img);
        scrollToBottom();
      }
      openaiMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result || { ok:true }),
      });
    }
  }
}

// ── Retry-Wrapper ─────────────────────────────────────────────────────────────
const RETRY_DELAYS = [3000, 6000, 12000];
const RETRYABLE    = /503|429|RESOURCE_EXHAUSTED|high demand|overloaded|quota|rate.?limit/i;

async function withRetry(fn, onStatus) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try { return await fn(); }
    catch (err) {
      const canRetry = RETRYABLE.test(err.message) && attempt < RETRY_DELAYS.length;
      if (!canRetry) throw err;
      const waitSec = RETRY_DELAYS[attempt] / 1000;
      onStatus(`⟳ Überlastet — nächster Versuch in ${waitSec}s…`);
      let r = waitSec;
      const tick = setInterval(() => { r--; if (r>0) onStatus(`⟳ Nächster Versuch in ${r}s…`); }, 1000);
      await new Promise(res => setTimeout(res, RETRY_DELAYS[attempt]));
      clearInterval(tick);
      onStatus('');
    }
  }
}

async function streamGeminiWithRetry(apiKey, history, model, sysPrompt, onChunk, tools, onStatus) {
  return withRetry(() => streamGemini(apiKey, history, model, sysPrompt, onChunk, tools), onStatus);
}
async function streamOpenAIWithRetry(apiKey, messages, model, onChunk, tools, onStatus) {
  return withRetry(() => streamOpenAI(apiKey, messages, model, onChunk, tools), onStatus);
}

// ── Gemini Streaming ──────────────────────────────────────────────────────────
async function streamGemini(apiKey, history, model, sysPrompt, onChunk, tools) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const body = {
    system_instruction: { parts:[{ text: sysPrompt }] },
    contents: history,
    generationConfig: { temperature:0.7, maxOutputTokens:4096, topP:0.9 },
    safetySettings: [
      { category:'HARM_CATEGORY_HARASSMENT',       threshold:'BLOCK_NONE' },
      { category:'HARM_CATEGORY_HATE_SPEECH',       threshold:'BLOCK_NONE' },
      { category:'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold:'BLOCK_NONE' },
      { category:'HARM_CATEGORY_DANGEROUS_CONTENT', threshold:'BLOCK_NONE' },
    ],
  };
  if (tools) { body.tools = tools; body.toolConfig = { functionCallingConfig:{ mode:'AUTO' } }; }

  const resp = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  if (!resp.ok) { const t = await resp.text(); let m=`HTTP ${resp.status}`; try{m+=': '+JSON.parse(t).error.message;}catch{} throw new Error(m); }

  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = ''; const fcs = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream:true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6).trim();
      if (d === '[DONE]') continue;
      try {
        const parts = JSON.parse(d).candidates?.[0]?.content?.parts || [];
        for (const p of parts) { if (p.text) onChunk(p.text); if (p.functionCall) fcs.push(p.functionCall); }
      } catch {}
    }
  }
  return fcs;
}

// ── OpenAI Streaming ──────────────────────────────────────────────────────────
async function streamOpenAI(apiKey, messages, model, onChunk, tools) {
  const body = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const t = await resp.text(); let m=`HTTP ${resp.status}`; try{m+=': '+JSON.parse(t).error?.message;}catch{} throw new Error(m); }

  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '';
  // Tool-Call-Accumulator: id → { id, type, function: { name, arguments } }
  const tcMap = {};   // index → partial tool call

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream:true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6).trim();
      if (d === '[DONE]') continue;
      try {
        const delta = JSON.parse(d).choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) onChunk(delta.content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!tcMap[idx]) tcMap[idx] = { id:'', type:'function', function:{ name:'', arguments:'' } };
            if (tc.id) tcMap[idx].id += tc.id;
            if (tc.function?.name) tcMap[idx].function.name += tc.function.name;
            if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch {}
    }
  }

  return Object.values(tcMap);
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function addCopyButton(metaEl, getTextFn) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = '⎘ Kopieren';
  btn.addEventListener('click', async () => {
    const text = getTextFn();
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = Object.assign(document.createElement('textarea'), { value:text, style:'position:fixed;opacity:0' });
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
    btn.textContent = '✓ Kopiert';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '⎘ Kopieren'; btn.classList.remove('copied'); }, 1500);
  });
  metaEl.appendChild(btn);
}

function addMsg(role, text, ctxPills) {
  const area = document.getElementById('chat-area');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const icons  = { user:'👤', assistant:'✦' };
  const labels = { user:'Du', assistant:'AI Analyst' };

  let ctxBadges = '';
  if (ctxPills?.length) {
    const ic = { api:'📡', network:'🌐', errors:'🔴', scripts:'📄', paused:'⏸', console:'⬛' };
    ctxBadges = ctxPills.map(p =>
      `<span style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--text1)">${ic[p]||''} ${p}</span>`
    ).join(' ');
  }

  div.innerHTML = `
    <div class="msg-meta">
      <span class="role-icon">${icons[role]||'?'}</span>
      <strong>${labels[role]||role}</strong>
      ${ctxBadges}
    </div>
    <div class="msg-bubble">${markdownToHtml(escHtml(text))}</div>`;

  if (role === 'assistant') {
    const metaEl   = div.querySelector('.msg-meta');
    const bubbleEl = div.querySelector('.msg-bubble');
    addCopyButton(metaEl, () => bubbleEl.textContent.trim());
  }
  area.appendChild(div);
  scrollToBottom();
}

function addAssistantBubble() {
  const area = document.getElementById('chat-area');
  const div  = document.createElement('div');
  div.className = 'msg assistant';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `<span class="role-icon">✦</span><strong>AI Analyst</strong> <span style="font-size:10px;color:var(--text2)">${currentProvider === 'openai' ? 'OpenAI' : 'Gemini'}</span>`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // content: reiner Text während Streaming, danach Markdown-HTML
  const content = document.createElement('div');
  bubble.appendChild(content);

  // cursor steht AUSSERHALB von content → wird nie überschrieben
  const cursor = document.createElement('span');
  cursor.innerHTML = '<span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span>';
  bubble.appendChild(cursor);

  addCopyButton(meta, () => content.textContent.trim());
  div.appendChild(meta);
  div.appendChild(bubble);
  area.appendChild(div);
  scrollToBottom();
  return { content, cursor };
}

function addToolCallBubble(name, args) {
  const area = document.getElementById('chat-area');
  const div  = document.createElement('div');
  div.className = 'msg tool-call';
  const argsStr = Object.entries(args).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  div.innerHTML = `
    <div class="msg-bubble">
      <span>⚙</span>
      <span class="tool-call-name">${escHtml(name)}</span>
      <span class="tool-call-args">(${escHtml(argsStr)})</span>
      <span class="tool-call-result" data-result>⏳</span>
    </div>`;
  area.appendChild(div);
  scrollToBottom();
  return div;
}

function updateToolCallResult(div, result) {
  const span = div.querySelector('[data-result]');
  if (!span) return;
  if (result?.ok === false) { span.textContent = `✗ ${result.error}`; span.className = 'tool-call-result err'; }
  else { span.textContent = '✓ ok'; span.className = 'tool-call-result ok'; }
}

function addSystemMsg(text) {
  const area = document.getElementById('chat-area');
  const div = document.createElement('div');
  div.className = 'msg system-msg';
  div.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  area.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const area = document.getElementById('chat-area');
  area.scrollTop = area.scrollHeight;
}

function setBtnState(disabled) {
  const btn = document.getElementById('btn-send');
  btn.disabled = disabled;
  btn.textContent = disabled ? '⏳' : '▶ Senden';
}

// ── Code-Block Copy-Buttons ───────────────────────────────────────────────────
function addCodeCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '⎘ Kopieren';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const text = pre.querySelector('code')?.textContent || pre.textContent;
      navigator.clipboard.writeText(text).catch(() => {
        const ta = Object.assign(document.createElement('textarea'),
          { value: text, style: 'position:fixed;opacity:0' });
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      });
      btn.textContent = '✓ Kopiert';
      btn.style.color = 'var(--green)';
      setTimeout(() => { btn.textContent = '⎘ Kopieren'; btn.style.color = ''; }, 1400);
    });
    pre.appendChild(btn);
  });
}

// ── Markdown → HTML ───────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAndFormat(text) { return markdownToHtml(escHtml(text)); }
function markdownToHtml(s) {
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^\- (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.split('\n\n').map(p => {
    p = p.trim();
    if (!p || p.startsWith('<')) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return s;
}
