// src/preload.js
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cdp', {
  // Targets & Verbindung
  getTargets:      ()          => ipcRenderer.invoke('cdp:getTargets'),
  connect:         (wsUrl)     => ipcRenderer.invoke('cdp:connect', wsUrl),
  send:            (method, params) => ipcRenderer.invoke('cdp:send', { method, params }),
  deepIntercept:   (enable)    => ipcRenderer.invoke('cdp:deepIntercept', enable),

  // Network
  getBody:         (requestId)      => ipcRenderer.invoke('cdp:getBody', requestId),

  // Debugger
  getScriptSource: (scriptId)       => ipcRenderer.invoke('cdp:getScriptSource', scriptId),
  setBreakpoint:   (loc)            => ipcRenderer.invoke('cdp:setBreakpoint', loc),
  removeBreakpoint:(id)             => ipcRenderer.invoke('cdp:removeBreakpoint', id),
  step:            (action)         => ipcRenderer.invoke('cdp:debuggerStep', action),
  evaluate:        (expr, frameId)  => ipcRenderer.invoke('cdp:evaluate', { expression: expr, callFrameId: frameId }),
  getProperties:   (objectId, own)  => ipcRenderer.invoke('cdp:getProperties', { objectId, ownProperties: own }),

  // Events empfangen
  on: (channel, cb) => {
    const allowed = ['cdp:status','cdp:error','cdp:network','cdp:debugger','cdp:runtime','cdp:page','cdp:hidden'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => cb(data));
    }
  },
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb),

  // Shell
  openExternal: (url) => ipcRenderer.send('shell:open', url),

  // AI-Chat-Fenster öffnen
  openAiWindow: () => ipcRenderer.send('ai:openWindow'),

  // Kontext für AI aktualisieren (Renderer schickt State an Main)
  pushContext: (ctx) => ipcRenderer.send('ai:updateContext', ctx),
});
