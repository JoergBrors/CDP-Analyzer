// src/preload-ai.js — Preload für das AI-Chat-Fenster
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ai', {
  // API-Key speichern/laden (provider = 'gemini' | 'openai')
  saveKey:    (provider, key) => ipcRenderer.invoke('ai:saveKey', { provider, key }),
  loadKey:    (provider)      => ipcRenderer.invoke('ai:loadKey', provider),

  // Gemini-Anfrage (streaming via events)
  chat:       (messages, model) => ipcRenderer.invoke('ai:chat', { messages, model }),

  // CDP-Kontext vom Haupt-Fenster holen
  getContext:      (type)      => ipcRenderer.invoke('ai:getContext', type),
  // Response-Body für spezifische Request-ID (aus getCdpContext('api')[n].id)
  getResponseBody: (requestId) => ipcRenderer.invoke('ai:getResponseBody', requestId),
  // Volltext-Suche in allen gecachten Request- und Response-Bodies
  searchBodies:    (query, maxResults) => ipcRenderer.invoke('ai:searchBodies', { query, maxResults }),

  // Browser-Steuerung via CDP
  browser: {
    navigate:   (url)   => ipcRenderer.invoke('browser:navigate', url),
    evaluate:   (expr)  => ipcRenderer.invoke('browser:evaluate', expr),
    screenshot: ()      => ipcRenderer.invoke('browser:screenshot'),
    getContent: ()      => ipcRenderer.invoke('browser:getContent'),
    reload:     ()      => ipcRenderer.invoke('browser:reload'),
  },

  // Events vom Main-Prozess
  on:  (ch, cb) => {
    const allowed = ['ai:chunk', 'ai:done', 'ai:error', 'ai:context-push'];
    if (allowed.includes(ch)) ipcRenderer.on(ch, (_, d) => cb(d));
  },
  off: (ch, cb) => ipcRenderer.removeListener(ch, cb),
});
