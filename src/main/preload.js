'use strict';

/*
 * Preload bridge. contextIsolation is ON and nodeIntegration is OFF, so the
 * renderer never touches Node/Electron directly — everything goes through this
 * tightly-scoped `window.silenceCutter` surface.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('silenceCutter', {
  // Resolve a dropped File's absolute path (replaces the deprecated File.path).
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // --- settings ---
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  importSettings: () => ipcRenderer.invoke('settings:import'),
  exportSettings: (current) => ipcRenderer.invoke('settings:export', current),

  // --- media / analysis ---
  importVideo: () => ipcRenderer.invoke('video:import'),
  runAnalysis: (payload) => ipcRenderer.invoke('analysis:run', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  // Absolute path → file:// URL the <video> preview element can load.
  toFileUrl: (filePath) => ipcRenderer.invoke('media:fileurl', filePath),

  // Progress for the running analysis/render job. Returns an unsubscribe fn.
  onJobProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },

  // --- export ---
  exportCutlist: (payload) => ipcRenderer.invoke('export:cutlist', payload),
  exportVideo: (payload) => ipcRenderer.invoke('export:video', payload),
  revealPath: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),

  // --- app info ---
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // Native menu items forward a command string here.
  onMenuCommand: (cb) => {
    const listener = (_event, command) => cb(command);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
});
