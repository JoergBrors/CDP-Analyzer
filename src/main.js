// src/main.js — Electron Main Process
'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, safeStorage } = require('electron');
const path     = require('path');
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const os       = require('os');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT    = 9222;
const KEY_FILE    = path.join(app.getPath('userData'), 'ai-key.json');
const PREFS_FILE  = path.join(app.getPath('userData'), 'prefs.json');

// ── Chrome-Pfade je Plattform ─────────────────────────────────────────────────
const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  win32: [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,  'Google\\Chrome\\Application\\chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES,  'Google\\Chrome\\Application\\chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,  'Chromium\\Application\\chrome.exe'),
  ].filter(Boolean),
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
};

function findChrome() {
  // 1. Bekannte Pfade
  const candidates = CHROME_CANDIDATES[process.platform] || [];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  // 2. macOS: Spotlight (mdfind) — findet Chrome auch in ungewöhnlichen Installationspfaden
  if (process.platform === 'darwin') {
    const searches = [
      { id: 'com.google.Chrome',        bin: 'Google Chrome' },
      { id: 'com.google.Chrome.canary', bin: 'Google Chrome Canary' },
      { id: 'org.chromium.Chromium',    bin: 'Chromium' },
    ];
    for (const { id, bin } of searches) {
      try {
        const apps = execSync(
          `mdfind "kMDItemCFBundleIdentifier == '${id}'" 2>/dev/null`,
          { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString().trim().split('\n').filter(Boolean);
        for (const appPath of apps) {
          const binary = path.join(appPath, 'Contents', 'MacOS', bin);
          if (fs.existsSync(binary)) return binary;
        }
      } catch { /* mdfind nicht verfügbar */ }
    }
  }

  // 3. Windows: Registry-Suche via PowerShell
  if (process.platform === 'win32') {
    try {
      const result = execSync(
        'powershell -NoProfile -Command "(Get-ItemProperty -Path \'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\' -ErrorAction SilentlyContinue).(default)"',
        { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* Registry nicht verfügbar */ }
  }

  // 4. PATH-Fallback
  try {
    const cmd = process.platform === 'win32' ? 'where chrome' : 'which google-chrome 2>/dev/null || which chromium 2>/dev/null';
    const found = execSync(cmd, { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch {}

  return null;
}

function checkChromeDebug() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 1500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function waitForChromeDebug(maxMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => checkChromeDebug().then(ok => {
      if (ok) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('Timeout: Chrome Debug-Port nicht erreichbar'));
      setTimeout(poll, 400);
    });
    poll();
  });
}

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8'); } catch {}
}

function createAppMenu() {
  const version = app.getVersion();

  app.setAboutPanelOptions({
    applicationName: 'CDP Analyzer',
    applicationVersion: version,
    version,
  });

  const fileMenu = process.platform === 'darwin'
    ? { label: 'Ablage', submenu: [{ role: 'close' }] }
    : { label: 'Datei', submenu: [{ role: 'quit', label: 'Beenden' }] };

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'CDP Analyzer',
      submenu: [
        { label: `Version ${version}`, enabled: false },
        { role: 'about', label: 'Über CDP Analyzer' },
        { type: 'separator' },
        { role: 'services', label: 'Dienste' },
        { type: 'separator' },
        { role: 'hide', label: 'CDP Analyzer ausblenden' },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: 'CDP Analyzer beenden' },
      ],
    }] : []),
    fileMenu,
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklertools umschalten' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Originalgröße' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild umschalten' },
      ],
    },
    {
      label: 'Hilfe',
      submenu: [
        { label: `Version ${version}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// In den Seiten-Kontext injiziertes Script: überschreibt die nativen Netzwerk-
// APIs und meldet jeden Aufruf über die CDP-Binding __cdpHidden zurück.
// Fängt auch das ab, was im Network-Panel oft fehlt (sendBeacon, WS, SSE).
const HOOK_SOURCE = `(function(){
  if (window.__cdpHooked || typeof window.__cdpHidden !== 'function') return;
  window.__cdpHooked = true;
  var report = function(o){ try { window.__cdpHidden(JSON.stringify(o)); } catch(e){} };

  // fetch
  var _fetch = window.fetch;
  if (_fetch) window.fetch = function(input, init){
    try {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var m = (init && init.method) || (input && input.method) || 'GET';
      report({ via:'fetch', method:m, url:url, body:(init&&init.body)?String(init.body).slice(0,2000):null });
    } catch(e){}
    return _fetch.apply(this, arguments);
  };

  // XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__m=m; this.__u=u; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b){
    report({ via:'xhr', method:this.__m, url:this.__u, body:b?String(b).slice(0,2000):null });
    return _send.apply(this, arguments);
  };

  // navigator.sendBeacon (Tracking – im Network-Panel oft unsichtbar)
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data){
      report({ via:'beacon', method:'POST', url:url, body:data?String(data).slice(0,2000):null });
      return _beacon(url, data);
    };
  }

  // WebSocket
  var _WS = window.WebSocket;
  if (_WS) {
    window.WebSocket = function(url, proto){
      report({ via:'websocket', method:'WS', url:url });
      var ws = proto!==undefined ? new _WS(url, proto) : new _WS(url);
      var _ws_send = ws.send;
      ws.send = function(d){ report({ via:'websocket', method:'WS→', url:url, body:d?String(d).slice(0,500):null }); return _ws_send.apply(ws, arguments); };
      return ws;
    };
    window.WebSocket.prototype = _WS.prototype;
  }

  // EventSource (Server-Sent Events)
  var _ES = window.EventSource;
  if (_ES) {
    window.EventSource = function(url, cfg){
      report({ via:'eventsource', method:'SSE', url:url });
      return cfg!==undefined ? new _ES(url, cfg) : new _ES(url);
    };
    window.EventSource.prototype = _ES.prototype;
  }
})();`;

let mainWindow   = null;
let splashWindow = null;
let aiWindow     = null;        // AI-Chat-Fenster
let cdpWs = null;             // WebSocket zum Browser-Target
let callbackMap = new Map();  // id → callback für CDP-Antworten
let cdpMsgId = 1;
let targetWsUrl = null;
let cachedChromePath = null;

// Shared CDP-Kontext (wird vom Renderer via IPC gefüllt)
let sharedContext = {
  requests:      [],   // letzte Network-Requests
  scripts:       [],   // geladene Script-Infos
  pausedState:   null, // Debugger-Pause-Daten
  consoleEntries:[],   // Console-Ausgaben
};

// ── Proaktiver Response-Body-Cache ────────────────────────────────────────────
// Chrome verwirft Response-Bodies wenn zu lange gewartet wird.
// Wir fetchen sie sofort nach loadingFinished für API-ähnliche Requests.
const responseBodyCache = new Map();   // requestId → { body, base64Encoded }
const requestInfoCache  = new Map();   // requestId → { mimeType, url }
const MAX_BODY_CACHE = 400;            // max Einträge (LRU)
const API_BODY_RE = /json|graphql|xml|text\/plain/i;
const API_URL_RE  = /\/(?:api|v\d+(?:\.\d+)*|graphql|odata|batch|intents|releases|policies|permissions?|graph|admin|config|health|reports?|metric|telemetry|collector)\//i;

function shouldCacheBody(mimeType, url) {
  return API_BODY_RE.test(mimeType || '') || API_URL_RE.test(url || '');
}
function evictBodyCache() {
  if (responseBodyCache.size > MAX_BODY_CACHE) {
    const toDelete = responseBodyCache.size - MAX_BODY_CACHE;
    let i = 0;
    for (const k of responseBodyCache.keys()) { responseBodyCache.delete(k); if (++i >= toDelete) break; }
  }
}

// ── Fenster erstellen ────────────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 420,
    resizable: false,
    center: true,
    frame: false,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'CDP Analyzer',
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1117',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'CDP Analyzer',
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function createAiWindow() {
  if (aiWindow && !aiWindow.isDestroyed()) { aiWindow.focus(); return; }
  aiWindow = new BrowserWindow({
    width: 700,
    height: 860,
    minWidth: 480,
    minHeight: 500,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'AI Browser Analyst',
    webPreferences: {
      preload: path.join(__dirname, 'preload-ai.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aiWindow.loadFile(path.join(__dirname, '..', 'ai-chat.html'));
  aiWindow.on('closed', () => { aiWindow = null; });
}

app.whenReady().then(() => {
  createAppMenu();
  createSplashWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── CDP Helpers ──────────────────────────────────────────────────────────────
function cdpSend(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('CDP nicht verbunden'));
    }
    const id = cdpMsgId++;
    callbackMap.set(id, { resolve, reject });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;   // flatten-Mode: an Worker/iframe-Session
    cdpWs.send(JSON.stringify(msg));
  });
}

// Aktive Worker/Service-Worker-Sessions: sessionId → targetInfo
let attachedSessions = new Map();
// Deep-Intercept-Zustand (Fetch-Domain + Monkey-Patch-Injection)
let deepIntercept = false;

function toRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function toAi(channel, data) {
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.webContents.send(channel, data);
  }
}

// ── Targets vom Browser abrufen ──────────────────────────────────────────────
async function fetchTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Mit Target verbinden ─────────────────────────────────────────────────────
function connectToTarget(wsUrl) {
  if (cdpWs) { try { cdpWs.close(); } catch (_) {} }

  cdpWs = new WebSocket(wsUrl);
  targetWsUrl = wsUrl;

  cdpWs.on('open', async () => {
    attachedSessions = new Map();
    deepIntercept = false;
    toRenderer('cdp:status', { connected: true, url: wsUrl });

    // Domänen aktivieren
    await cdpSend('Network.enable', { maxPostDataSize: 65536 });
    await cdpSend('Debugger.enable');
    await cdpSend('Runtime.enable');
    await cdpSend('DOM.enable');
    await cdpSend('Page.enable');

    // Versteckte Calls aus Workern/Service-Workern/iframes sichtbar machen:
    // automatisch an alle Sub-Targets attachen (flatten = ein WS, Events mit sessionId)
    await cdpSend('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  });

  cdpWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    // Antworten auf gesendete Befehle
    if (msg.id !== undefined) {
      const cb = callbackMap.get(msg.id);
      if (cb) {
        callbackMap.delete(msg.id);
        msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
      }
      return;
    }

    // Events weiterleiten (sessionId gesetzt = aus Worker/iframe-Target)
    routeEvent(msg.method, msg.params, msg.sessionId);
  });

  cdpWs.on('close', () => {
    toRenderer('cdp:status', { connected: false });
  });

  cdpWs.on('error', (err) => {
    toRenderer('cdp:error', err.message);
  });
}

// ── Events an Renderer routen ────────────────────────────────────────────────
function routeEvent(method, params, sessionId) {
  if (!method) return;

  // ── Neues Sub-Target (Worker, Service-Worker, iframe) ──────────────────────
  if (method === 'Target.attachedToTarget') {
    onTargetAttached(params);
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    attachedSessions.delete(params.sessionId);
    return;
  }

  // ── Fetch-Interception (Deep Intercept): jeden Request abfangen ────────────
  if (method === 'Fetch.requestPaused') {
    const r = params.request || {};
    toRenderer('cdp:hidden', { source: 'intercept', sessionId, data: {
      requestId: 'fetch-' + params.requestId,
      method: r.method, url: r.url, headers: r.headers, postData: r.postData,
      resourceType: params.resourceType,
    }});
    // sofort weiterlaufen lassen, sonst hängt die Seite
    cdpSend('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
    return;
  }

  // ── Monkey-Patch-Reporter aus dem injizierten Script ───────────────────────
  if (method === 'Runtime.bindingCalled' && params.name === '__cdpHidden') {
    let data; try { data = JSON.parse(params.payload); } catch { data = { raw: params.payload }; }
    toRenderer('cdp:hidden', { source: data.via || 'hook', sessionId, data });
    return;
  }

  // Network (Haupt-Target wie bisher; aus Sub-Targets mit sessionId markiert)
  if (method.startsWith('Network.')) {
    // ── Body-Cache: MIME + URL tracken ─────────────────────────────────────
    if (method === 'Network.responseReceived') {
      const { requestId, response } = params;
      if (requestId && response) {
        requestInfoCache.set(requestId, { mimeType: response.mimeType || '', url: response.url || '' });
        // Alten Info-Cache aufräumen
        if (requestInfoCache.size > 800) {
          const oldest = requestInfoCache.keys().next().value;
          requestInfoCache.delete(oldest);
        }
      }
    }

    // ── Body-Cache: sofort fetchen wenn Loading fertig ──────────────────────
    if (method === 'Network.loadingFinished') {
      const { requestId } = params;
      const info = requestInfoCache.get(requestId);
      if (info && shouldCacheBody(info.mimeType, info.url) && !responseBodyCache.has(requestId)) {
        // Asynchron, blockiert nicht den Event-Flow
        cdpSend('Network.getResponseBody', { requestId }, sessionId)
          .then(result => {
            if (result && result.body !== undefined) {
              responseBodyCache.set(requestId, { body: result.body, base64Encoded: !!result.base64Encoded });
              evictBodyCache();
            }
          })
          .catch(() => { /* Body nicht mehr verfügbar – kein Problem */ });
      }
    }

    toRenderer('cdp:network', { method, params, sessionId });
  }
  else if (method.startsWith('Debugger.')) {
    toRenderer('cdp:debugger', { method, params });
  }
  else if (method.startsWith('Runtime.')) {
    toRenderer('cdp:runtime', { method, params });
  }
  else if (method.startsWith('Page.')) {
    toRenderer('cdp:page', { method, params });
  }
}

// ── Sub-Target verbinden und überwachen ──────────────────────────────────────
async function onTargetAttached(params) {
  const { sessionId, targetInfo } = params;
  if (!sessionId || !targetInfo) return;
  attachedSessions.set(sessionId, targetInfo);
  toRenderer('cdp:hidden', { source: 'target', data: {
    event: 'attached', type: targetInfo.type, url: targetInfo.url, title: targetInfo.title,
  }});
  try {
    // Network im Sub-Target aktivieren → dessen Requests werden sichtbar
    await cdpSend('Network.enable', { maxPostDataSize: 65536 }, sessionId);
    await cdpSend('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    // Deep-Intercept ggf. auch im Sub-Target scharf schalten
    if (deepIntercept) {
      await cdpSend('Fetch.enable', {}, sessionId).catch(() => {});
    }
  } catch (_) { /* manche Targets erlauben kein Network.enable */ }
}

// ── Splash IPC Handler ───────────────────────────────────────────────────────

ipcMain.handle('splash:check', async () => {
  const send = (phase, msg) =>
    splashWindow?.webContents?.send('splash:status', { phase, msg });

  send('checking-port', 'Prüfe Chrome Remote-Debugging auf Port 9222…');
  const debugRunning = await checkChromeDebug();
  const prefs        = loadPrefs();

  if (debugRunning) {
    return { chromeInstalled: true, debugRunning: true,
             chromePath: null, savedProfile: prefs.chromeProfile || null };
  }

  send('searching', 'Suche Chrome-Installation im System…');
  const chromePath = cachedChromePath || findChrome();
  cachedChromePath = chromePath || null;

  if (chromePath) {
    send('found', chromePath);
  } else {
    send('not-found', 'Chrome wurde nicht gefunden.');
  }

  return { chromeInstalled: !!chromePath, debugRunning: false,
           chromePath, savedProfile: prefs.chromeProfile || null };
});

ipcMain.handle('splash:startChrome', async (_, profileDir, requestedChromePath) => {
  const chromePath = requestedChromePath || cachedChromePath || findChrome();
  if (!chromePath) return { ok: false, error: 'Chrome nicht gefunden.' };
  if (!fs.existsSync(chromePath)) {
    cachedChromePath = null;
    return { ok: false, error: `Chrome-Pfad existiert nicht mehr: ${chromePath}` };
  }
  cachedChromePath = chromePath;

  const profile = profileDir || path.join(os.tmpdir(), 'cdp-debug-profile');
  // Profilpfad merken
  const prefs = loadPrefs();
  prefs.chromeProfile = profileDir || '';
  savePrefs(prefs);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
  ];

  try {
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      ...(process.platform === 'win32' ? { windowsHide: false } : {}),
    });
    child.unref();

    await waitForChromeDebug(8000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('splash:proceed', () => {
  createWindow();
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
});

// ── IPC Handler (Renderer → Main) ────────────────────────────────────────────

// Targets abrufen
ipcMain.handle('cdp:getTargets', async () => {
  try {
    const targets = await fetchTargets();
    return { ok: true, targets };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Mit Target verbinden
ipcMain.handle('cdp:connect', async (_, wsUrl) => {
  try {
    connectToTarget(wsUrl);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Generischen CDP-Befehl abschicken
ipcMain.handle('cdp:send', async (_, { method, params }) => {
  try {
    const result = await cdpSend(method, params || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Deep Intercept ein-/ausschalten: fängt JEDEN Request ab + hookt fetch/XHR/
// sendBeacon/WebSocket/EventSource via injiziertem Script (vor Seiten-JS).
ipcMain.handle('cdp:deepIntercept', async (_, enable) => {
  try {
    deepIntercept = !!enable;
    if (enable) {
      // 1) Fetch-Domain: alle Requests pausieren → in routeEvent fortgesetzt
      await cdpSend('Fetch.enable', {});
      for (const sid of attachedSessions.keys()) {
        await cdpSend('Fetch.enable', {}, sid).catch(() => {});
      }
      // 2) Monkey-Patch-Reporter registrieren + Script vor jedem Dokument injizieren
      await cdpSend('Runtime.addBinding', { name: '__cdpHidden' }).catch(() => {});
      await cdpSend('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE });
      // 3) sofort im aktuellen Dokument aktivieren (ohne Reload)
      await cdpSend('Runtime.evaluate', { expression: HOOK_SOURCE, includeCommandLineAPI: false }).catch(() => {});
    } else {
      await cdpSend('Fetch.disable', {}).catch(() => {});
      for (const sid of attachedSessions.keys()) {
        await cdpSend('Fetch.disable', {}, sid).catch(() => {});
      }
    }
    return { ok: true, enabled: deepIntercept };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Response Body laden — Cache-first, dann Live-Fetch
ipcMain.handle('cdp:getBody', async (_, requestId) => {
  // 1. Proaktiv gecachter Body?
  if (responseBodyCache.has(requestId)) {
    return { ok: true, result: responseBodyCache.get(requestId) };
  }
  // 2. Live-Fetch (klappt nur wenn Body noch in Chrome-Cache)
  try {
    const result = await cdpSend('Network.getResponseBody', { requestId });
    // Direkt cachen für spätere Anfragen
    if (result && result.body !== undefined) {
      responseBodyCache.set(requestId, { body: result.body, base64Encoded: !!result.base64Encoded });
      evictBodyCache();
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── AI: Response-Body für bestimmte Request-ID ───────────────────────────────
ipcMain.handle('ai:getResponseBody', async (_, requestId) => {
  if (responseBodyCache.has(requestId)) {
    const { body, base64Encoded } = responseBodyCache.get(requestId);
    if (base64Encoded) return { ok: true, body: `<Base64, ${body.length} Zeichen>`, base64Encoded: true };
    return { ok: true, body: body.slice(0, 80000) };
  }
  try {
    const result = await cdpSend('Network.getResponseBody', { requestId });
    if (result?.body !== undefined) {
      responseBodyCache.set(requestId, { body: result.body, base64Encoded: !!result.base64Encoded });
      evictBodyCache();
    }
    if (result?.base64Encoded) return { ok: true, body: `<Base64, ${(result.body||'').length} Zeichen>`, base64Encoded: true };
    return { ok: true, body: (result?.body || '').slice(0, 80000) };
  } catch (e) {
    return { ok: false, error: `Body nicht verfügbar: ${e.message}` };
  }
});

// ── AI: Volltext-Suche in allen gecachten Request- und Response-Bodies ────────
ipcMain.handle('ai:searchBodies', async (_, { query, maxResults = 8 }) => {
  if (!query || query.length < 2) return { ok: false, error: 'Suchbegriff zu kurz' };
  const lq = query.toLowerCase();
  const results = [];

  function findSnippets(text, limit = 5) {
    const snips = [];
    let pos = 0;
    while (snips.length < limit) {
      const found = text.toLowerCase().indexOf(lq, pos);
      if (found === -1) break;
      snips.push(text.slice(Math.max(0, found - 120), Math.min(text.length, found + 400)));
      pos = found + 1;
    }
    return snips;
  }

  // 1. Response-Bodies (gecacht)
  for (const [requestId, cached] of responseBodyCache) {
    if (results.length >= maxResults) break;
    if (!cached.body || cached.base64Encoded) continue;
    if (!cached.body.toLowerCase().includes(lq)) continue;
    const req = sharedContext.requests.find(r => r.id === requestId);
    const info = requestInfoCache.get(requestId);
    results.push({
      type: 'response',
      requestId,
      url:    req?.url || info?.url || '',
      method: req?.method || '',
      status: req?.status,
      snippets: findSnippets(cached.body),
    });
  }

  // 2. Request-Bodies (postData in sharedContext)
  for (const r of sharedContext.requests) {
    if (results.length >= maxResults * 2) break;
    if (!r.postData) continue;
    if (!r.postData.toLowerCase().includes(lq)) continue;
    // Kein Duplikat mit Response-Ergebnis
    if (results.some(x => x.requestId === r.id && x.type === 'response')) continue;
    results.push({
      type: 'request',
      requestId: r.id,
      url:    r.url,
      method: r.method,
      status: r.status,
      snippets: findSnippets(r.postData),
    });
  }

  return {
    ok: true,
    query,
    results,
    searched: { responseBodies: responseBodyCache.size, requestBodies: sharedContext.requests.filter(r=>r.postData).length },
  };
});

// Script Source laden
ipcMain.handle('cdp:getScriptSource', async (_, scriptId) => {
  try {
    const result = await cdpSend('Debugger.getScriptSource', { scriptId });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Breakpoint setzen
ipcMain.handle('cdp:setBreakpoint', async (_, { scriptId, lineNumber, columnNumber }) => {
  try {
    const result = await cdpSend('Debugger.setBreakpoint', {
      location: { scriptId, lineNumber, columnNumber: columnNumber || 0 },
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Breakpoint entfernen
ipcMain.handle('cdp:removeBreakpoint', async (_, breakpointId) => {
  try {
    await cdpSend('Debugger.removeBreakpoint', { breakpointId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Step-Befehle
ipcMain.handle('cdp:debuggerStep', async (_, action) => {
  const methods = {
    resume:   'Debugger.resume',
    stepOver: 'Debugger.stepOver',
    stepInto: 'Debugger.stepInto',
    stepOut:  'Debugger.stepOut',
    pause:    'Debugger.pause',
  };
  try {
    const result = await cdpSend(methods[action] || 'Debugger.resume');
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Expression auswerten (Object Watch / REPL)
ipcMain.handle('cdp:evaluate', async (_, { expression, callFrameId }) => {
  try {
    const params = {
      expression,
      generatePreview: true,
      returnByValue: false,
    };
    if (callFrameId) {
      const result = await cdpSend('Debugger.evaluateOnCallFrame', {
        callFrameId,
        ...params,
      });
      return { ok: true, result };
    } else {
      const result = await cdpSend('Runtime.evaluate', params);
      return { ok: true, result };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Object Properties abrufen (für Object Watcher)
ipcMain.handle('cdp:getProperties', async (_, { objectId, ownProperties }) => {
  try {
    const result = await cdpSend('Runtime.getProperties', {
      objectId,
      ownProperties: ownProperties !== false,
      generatePreview: true,
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Browser-Steuerung via CDP ─────────────────────────────────────────────────
ipcMain.handle('browser:navigate', async (_, url) => {
  try {
    const result = await cdpSend('Page.navigate', { url });
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:evaluate', async (_, expression) => {
  try {
    const r = await cdpSend('Runtime.evaluate', {
      expression,
      returnByValue: true,
      generatePreview: false,
    });
    return { ok: true, result: r.result?.value, type: r.result?.type };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:screenshot', async () => {
  try {
    const result = await cdpSend('Page.captureScreenshot', { format: 'png' });
    return { ok: true, data: result.data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:reload', async () => {
  try {
    await cdpSend('Page.reload', {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser:getContent', async () => {
  try {
    const r = await cdpSend('Runtime.evaluate', {
      expression: `(function(){return{url:location.href,title:document.title,text:(document.body&&document.body.innerText||'').slice(0,5000)};})()`,
      returnByValue: true,
    });
    return { ok: true, result: r.result?.value };
  } catch (e) { return { ok: false, error: e.message }; }
});

// URL extern öffnen
ipcMain.on('shell:open', (_, url) => shell.openExternal(url));

// ── AI-Fenster öffnen ────────────────────────────────────────────────────────
ipcMain.on('ai:openWindow', () => createAiWindow());

// ── API-Key speichern/laden (per Provider: gemini | openai) ──────────────────
// Verschlüsselung via Electron safeStorage (macOS Keychain / Windows DPAPI / Linux libsecret)
// Gespeichertes Format: { enc: true, keys: { gemini: "<base64>", openai: "<base64>" } }
// Fallback auf Plaintext wenn safeStorage nicht verfügbar (headless CI etc.)

function encryptKey(str) {
  if (!safeStorage.isEncryptionAvailable()) return { v: str };
  return { v: safeStorage.encryptString(str).toString('base64'), enc: true };
}

function decryptKey(entry) {
  if (!entry) return null;
  if (!entry.enc) return entry.v; // Plaintext-Fallback oder Legacy-String
  try { return safeStorage.decryptString(Buffer.from(entry.v, 'base64')); }
  catch { return null; }
}

ipcMain.handle('ai:saveKey', (_, payload) => {
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch {}
    data.enc  = true;
    data.keys = data.keys || {};
    const provider = typeof payload === 'string' ? 'gemini' : payload.provider;
    const key      = typeof payload === 'string' ? payload  : payload.key;
    data.keys[provider] = encryptKey(key);
    // Legacy-Feld entfernen — nicht mehr Plaintext speichern
    delete data.key;
    fs.writeFileSync(KEY_FILE, JSON.stringify(data), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('ai:loadKey', (_, provider = null) => {
  try {
    if (!fs.existsSync(KEY_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (!provider) {
      // Alle Provider entschlüsselt zurückgeben
      const result = {};
      for (const [p, entry] of Object.entries(data.keys || {})) {
        result[p] = decryptKey(entry);
      }
      return { keys: result };
    }
    const entry = data.keys?.[provider];
    if (entry) return decryptKey(entry);
    // Legacy: unverschlüsselter String (Migration beim ersten Laden)
    if (provider === 'gemini' && typeof data.key === 'string') return data.key;
    return null;
  } catch { return null; }
});

// ── Shared Context vom Renderer aktualisieren ────────────────────────────────
ipcMain.on('ai:updateContext', (_, ctx) => {
  if (ctx.requests      !== undefined) sharedContext.requests      = ctx.requests;
  if (ctx.scripts       !== undefined) sharedContext.scripts       = ctx.scripts;
  if (ctx.pausedState   !== undefined) sharedContext.pausedState   = ctx.pausedState;
  if (ctx.consoleEntries!== undefined) sharedContext.consoleEntries= ctx.consoleEntries;
});

// ── Kontext für AI-Fenster bereitstellen ──────────────────────────────────────
ipcMain.handle('ai:getContext', (_, type) => {
  switch (type) {
    case 'network':
      return { ok: true, data: sharedContext.requests.slice(-50).map(r => ({
        method: r.method, status: r.status, type: r.type,
        url: r.url, size: r.size, timeMs: r.timeMs,
        initiatorType: r.initiatorType, mime: r.mime,
        failed: r.failed, errorText: r.errorText,
      }))};
    case 'errors':
      return { ok: true, data: sharedContext.requests.filter(r =>
        r.failed || (r.status && r.status >= 400)
      ).map(r => ({ method: r.method, status: r.status, url: r.url, errorText: r.errorText }))};
    case 'scripts':
      return { ok: true, data: sharedContext.scripts };
    case 'paused':
      return { ok: true, data: sharedContext.pausedState };
    case 'console':
      return { ok: true, data: sharedContext.consoleEntries.slice(-30) };
    case 'api': {
      const API_RE = /\/(?:api|rest|graphql|v\d+(?:\.\d+)*|odata|intents|releases|batch|policies|settings|admin|health|reports?|metric|telemetry|collector|permissions?|graph|sync|deploy|config)\//i;
      const HOST_RE = /(?:api\.|apis\.|graph\.|platform\.|gateway\.|config\.|portal\.|data\.|events\.|analytics\.|collector\.|management\.)/i;
      return { ok: true, data: sharedContext.requests.filter(r => {
        if (r.type === 'xhr' || r.type === 'fetch') return true;
        if (r.mime && (r.mime.includes('json') || r.mime.includes('graphql'))) return true;
        if (r.url && API_RE.test(r.url)) return true;
        try { if (HOST_RE.test(new URL(r.url).hostname)) return true; } catch {}
        return false;
      }).slice(-50).map(r => {
        const isBatch = /\$batch|\/batch\?api-version/i.test(r.url || '');
        return {
          id: r.id,   // ← Request-ID für getResponseBody / searchInData
          method: r.method, status: r.status, url: r.url,
          mime: r.mime, size: r.size, timeMs: r.timeMs,
          requestHeaders: r.headers, responseHeaders: r.responseHeaders,
          postData: r.postData ? r.postData.slice(0, isBatch ? 10000 : 2000) : null,
          isBatch,
          failed: r.failed, errorText: r.errorText,
          hasBody: responseBodyCache.has(r.id),   // zeigt an ob Body gecacht ist
        };
      })};
    };
    default:
      return { ok: false, error: 'Unbekannter Kontext-Typ' };
  }
});
