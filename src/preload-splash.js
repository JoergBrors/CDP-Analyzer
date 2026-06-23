'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  check:       ()           => ipcRenderer.invoke('splash:check'),
  startChrome: (profileDir) => ipcRenderer.invoke('splash:startChrome', profileDir),
  proceed:     ()           => ipcRenderer.send('splash:proceed'),
  openExternal:(url)        => ipcRenderer.send('shell:open', url),
  onStatus:    (cb)         => ipcRenderer.on('splash:status', (_, d) => cb(d)),
});
