'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// Minimal, explicit surface exposed to the web UI (no Node access in the renderer).
// The only door between the UI and the system: each function maps to one IPC message handled in main.js.
contextBridge.exposeInMainWorld('baymax', {
  getConfig: () => ipcRenderer.sendSync('baymax:get-config'),
  setMode: (mode) => ipcRenderer.send('baymax:set-mode', mode),
  quit: () => ipcRenderer.send('baymax:quit'),
  openExternal: (url) => ipcRenderer.send('baymax:open-external', url),
  getAutostart: () => ipcRenderer.sendSync('baymax:get-autostart'),
  setAutostart: (on) => ipcRenderer.send('baymax:set-autostart', !!on),
  onCursor: (cb) => {
    const handler = (_e, pos) => cb(pos)
    ipcRenderer.on('baymax:cursor', handler)
    return () => ipcRenderer.removeListener('baymax:cursor', handler)
  },
  onModeRequest: (cb) => {
    const handler = (_e, mode) => cb(mode)
    ipcRenderer.on('baymax:request-mode', handler)
    return () => ipcRenderer.removeListener('baymax:request-mode', handler)
  },
})
