'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');

const isMac = process.platform === 'darwin';
const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'flv', 'ts', 'wmv'];

/** @type {BrowserWindow | null} */
let mainWindow = null;

/* ------------------------------------------------------------------ */
/*  Window                                                             */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: isMac ? '#00000000' : '#0b0e14',
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#c9d3e6', height: 44 },
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/* ------------------------------------------------------------------ */
/*  Application menu                                                   */
/* ------------------------------------------------------------------ */

function send(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:command', command);
  }
}

function buildMenu() {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('toggle-settings') },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import Video…', accelerator: 'CmdOrCtrl+O', click: () => send('import-video') },
        { label: 'Analyze', accelerator: 'CmdOrCtrl+R', click: () => send('analyze') },
        { type: 'separator' },
        { label: 'Export Trimmed Video…', accelerator: 'CmdOrCtrl+E', click: () => send('export-video') },
        { label: 'Export Cut List…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('export-cutlist') },
        { type: 'separator' },
        { label: 'Import Settings…', click: () => send('import-settings') },
        { label: 'Export Settings…', click: () => send('export-settings') },
        { label: 'Reset Settings to Defaults', click: () => send('reset-settings') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Settings', accelerator: isMac ? undefined : 'Ctrl+,', click: () => send('toggle-settings') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])] },
    {
      role: 'help',
      submenu: [
        { label: 'About Silence Cutter', click: () => send('about') },
        { label: 'Open Settings Folder', click: () => shell.openPath(settings.SETTINGS_DIR) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/*  Mock analysis engine (real ffmpeg pipeline lands in v0.2)         */
/* ------------------------------------------------------------------ */

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Produces believable, deterministic dead-air segments + a waveform so the
// timeline looks alive. Swapped for real ffmpeg silencedetect output in v0.2.
function mockAnalyze(videoPath, config) {
  const rnd = mulberry32(hashString(videoPath || 'demo-reel'));
  const duration = 180 + Math.floor(rnd() * 660); // 3–14 min
  const minSil = config?.detection?.minSilenceSec ?? 1.5;

  const segments = [];
  let t = 4 + rnd() * 12;
  let id = 0;
  while (t < duration - 8) {
    t += 6 + rnd() * 42; // a stretch of talking
    if (t >= duration - 8) break;
    const silence = minSil + rnd() * (minSil * 3 + 3);
    segments.push({
      id: id++,
      start: Number(t.toFixed(2)),
      end: Number(Math.min(duration - 1, t + silence).toFixed(2)),
      cut: true,
    });
    t += silence;
  }

  const N = 1400;
  const peaks = new Array(N);
  for (let i = 0; i < N; i++) {
    const time = (i / N) * duration;
    const inSilence = segments.some((s) => time >= s.start && time <= s.end);
    const amp = inSilence ? 0.02 + rnd() * 0.05 : 0.2 + rnd() * 0.78;
    peaks[i] = Number(Math.min(1, amp).toFixed(3));
  }

  return {
    mocked: true,
    videoPath,
    duration,
    thresholdDb: config?.detection?.thresholdDb ?? -30,
    segments,
    peaks,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  IPC                                                                */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: app.name,
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    settingsDir: settings.SETTINGS_DIR,
  }));

  // Settings ---------------------------------------------------------
  ipcMain.handle('settings:load', () => settings.load());
  ipcMain.handle('settings:save', (_e, partial) => settings.save(partial));
  ipcMain.handle('settings:reset', () => settings.reset());

  ipcMain.handle('settings:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Settings',
      properties: ['openFile'],
      filters: [{ name: 'Silence Cutter Settings', extensions: ['dom'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePaths[0]) return { canceled: true };
    try {
      return { canceled: false, settings: settings.importFrom(filePaths[0]), path: filePaths[0] };
    } catch (err) {
      return { canceled: false, error: `Could not read ${path.basename(filePaths[0])}: ${err.message}` };
    }
  });

  ipcMain.handle('settings:export', async (_e, current) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Settings',
      defaultPath: 'silence-cutter.dom',
      filters: [{ name: 'Silence Cutter Settings', extensions: ['dom'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    try {
      return { canceled: false, path: settings.exportTo(filePath, current) };
    } catch (err) {
      return { canceled: false, error: err.message };
    }
  });

  // Media ------------------------------------------------------------
  ipcMain.handle('video:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Video',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths[0]) return { canceled: true };
    const p = filePaths[0];
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* ignore */ }
    return { canceled: false, path: p, name: path.basename(p), ext: path.extname(p).slice(1).toLowerCase(), size };
  });

  ipcMain.handle('analysis:run', (_e, payload) => {
    const videoPath = payload?.videoPath || '';
    return mockAnalyze(videoPath, payload?.settings);
  });

  // Export -----------------------------------------------------------
  ipcMain.handle('export:cutlist', async (_e, payload) => {
    const base = payload?.videoName ? payload.videoName.replace(/\.[^.]+$/, '') : 'cutlist';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Cut List',
      defaultPath: `${base}.cutlist.json`,
      filters: [{ name: 'Cut List (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    const doc = {
      tool: 'Silence Cutter',
      version: app.getVersion(),
      generatedAt: new Date().toISOString(),
      source: payload?.videoPath || null,
      duration: payload?.duration ?? null,
      settings: payload?.settings ?? null,
      note: 'Non-destructive cut list. `cuts` = regions removed from the source.',
      cuts: payload?.cuts ?? [],
    };
    try {
      fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      return { canceled: false, path: filePath, count: doc.cuts.length };
    } catch (err) {
      return { canceled: false, error: err.message };
    }
  });

  // The real render is v0.2 — the UI wiring is here and ready.
  ipcMain.handle('export:video', () => ({
    notImplemented: true,
    message: 'Video rendering arrives in v0.2 (ffmpeg pipeline). Cut list export works today.',
  }));
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
