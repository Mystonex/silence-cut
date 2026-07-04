'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const engine = require('./ffmpeg');

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
  // Closing the window (or quitting) must not orphan a running ffmpeg child.
  mainWindow.on('close', abortActiveJob);
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
/*  Job management (analysis / render share one cancelable slot)       */
/* ------------------------------------------------------------------ */

// Only one heavy ffmpeg job runs at a time (the UI is single-video). We reject a
// second job rather than aborting the first: silently superseding an in-flight
// render could delete its output and report a phantom "canceled". Explicit
// cancel (job:cancel) and teardown (window close / quit) are the only aborts.
let activeJob = null; // { kind, controller }

function beginJob(kind) {
  const controller = new AbortController();
  activeJob = { kind, controller };
  return activeJob;
}

function endJob(job) {
  if (activeJob === job) activeJob = null;
}

function abortActiveJob() {
  if (activeJob) { try { activeJob.controller.abort(); } catch { /* ignore */ } }
}

// True when `a` and `b` name the same file on disk. Guards against rendering a
// video onto its own source. Uses dev+inode when both exist (authoritative
// across symlinks/case), else canonicalizes and compares case-insensitively on
// the platforms whose default filesystems are case-insensitive.
function isSameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { /* the output usually doesn't exist yet — fall through */ }
  const canon = (p) => {
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); }
    catch { return path.resolve(p); }
  };
  let ca = canon(a);
  let cb = canon(b);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    ca = ca.toLowerCase();
    cb = cb.toLowerCase();
  }
  return ca === cb;
}

function sendProgress(phase, ratio, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('job:progress', { phase, ratio, ...(extra || {}) });
  }
}

function isCancel(err) {
  return err && (err.message === 'Canceled' || err.name === 'AbortError');
}

// Engine options derived from the current settings object.
function engineOpts(s) {
  const ffmpegPath = s && s.app && typeof s.app.ffmpegPath === 'string' ? s.app.ffmpegPath.trim() : '';
  return { ffmpegPath: ffmpegPath || undefined };
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

  ipcMain.handle('analysis:run', async (_e, payload) => {
    const videoPath = payload?.videoPath || '';
    if (!videoPath) throw new Error('No video to analyze.');
    if (activeJob) return { busy: true };

    const s = payload?.settings || settings.load();
    const det = s.detection || {};
    const job = beginJob('analyze');
    try {
      const result = await engine.analyze(
        videoPath,
        {
          thresholdDb: det.thresholdDb,
          minSilenceSec: det.minSilenceSec,
          ...engineOpts(s),
        },
        (ratio) => sendProgress('analyze', ratio),
        job.controller.signal,
      );
      return result;
    } catch (err) {
      if (isCancel(err)) return { canceled: true };
      throw new Error(err.message || 'Analysis failed.');
    } finally {
      endJob(job);
    }
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

  ipcMain.handle('export:video', async (_e, payload) => {
    const videoPath = payload?.videoPath;
    const keep = Array.isArray(payload?.keep) ? payload.keep : [];
    if (!videoPath) return { error: 'No source video to render.' };
    if (keep.length === 0) return { error: 'Nothing to render — every part is marked as a cut.' };
    if (activeJob) return { error: 'Another job is already running. Wait for it to finish or cancel it.' };

    const s = payload?.settings || settings.load();
    const format = (s.output && s.output.format) || 'mp4';
    const suffix = (s.output && typeof s.output.suffix === 'string') ? s.output.suffix : '_silencecut';
    const base = payload?.videoName
      ? payload.videoName.replace(/\.[^.]+$/, '')
      : path.basename(videoPath).replace(/\.[^.]+$/, '');
    const defaultPath = path.join(path.dirname(videoPath), `${base}${suffix}.${format}`);

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Trimmed Video',
      defaultPath,
      filters: [{ name: `${format.toUpperCase()} Video`, extensions: [format] }],
    });
    if (canceled || !filePath) return { canceled: true };

    // Guard against overwriting the source in place (case-insensitive FS aware).
    if (isSameFile(filePath, videoPath)) {
      return { error: 'Choose a different filename — that would overwrite the source video.' };
    }

    const job = beginJob('render');
    try {
      sendProgress('render', 0);
      const res = await engine.renderCut(
        videoPath,
        keep,
        filePath,
        {
          hasAudio: payload?.hasAudio !== false,
          duration: payload?.duration,
          ...engineOpts(s),
        },
        (ratio) => sendProgress('render', ratio),
        job.controller.signal,
      );
      return { canceled: false, path: res.path, keptRanges: res.keptRanges, keptDuration: res.keptDuration };
    } catch (err) {
      // Clean up a partial output file on failure/cancel.
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
      if (isCancel(err)) return { canceled: true, reason: 'canceled' };
      return { error: err.message || 'Rendering failed.' };
    } finally {
      endJob(job);
    }
  });

  // Cancel whatever ffmpeg job is currently running.
  ipcMain.handle('job:cancel', () => {
    abortActiveJob();
    return { canceled: true };
  });

  // Reveal an exported file in Finder/Explorer.
  ipcMain.handle('shell:reveal', (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) { shell.showItemInFolder(filePath); return { ok: true }; }
    return { ok: false };
  });
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

// Never let a spawned ffmpeg child outlive the app.
app.on('before-quit', abortActiveJob);

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
