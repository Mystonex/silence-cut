'use strict';

/*
 * Silence Cutter settings store.
 *
 * Config lives in <repo>/settings as `.dom` files (Dead-air Options Manifest).
 * On disk it's plain JSON — the extension is just for funsy.
 */

const fs = require('fs');
const path = require('path');

// Source-of-truth defaults, used if default.dom is missing/corrupt.
const DEFAULTS = Object.freeze({
  $format: 'Silence Cutter DOM — Dead-air Options Manifest',
  $schema: 1,
  version: '0.1.0',
  detection: {
    thresholdDb: -30,
    minSilenceSec: 1.5,
    leadInSec: 0.4,
    leadOutSec: 0.4,
    minKeepSec: 0.5,
  },
  output: {
    mode: 'both', // video | cutlist | both
    format: 'mp4', // mp4 | mkv | mov
    suffix: '_silencecut',
    cutlistFormat: 'json', // json | edl
  },
  app: {
    theme: 'dark', // dark | light | auto
    accent: '#6ee7ff',
    ffmpegPath: '',
  },
});

const GROUPS = ['detection', 'output', 'app'];

const ENUMS = {
  'output.mode': ['video', 'cutlist', 'both'],
  'output.format': ['mp4', 'mkv', 'mov'],
  'output.cutlistFormat': ['json', 'edl'],
  'app.theme': ['dark', 'light', 'auto'],
};

const RANGES = {
  'detection.thresholdDb': [-90, 0],
  'detection.minSilenceSec': [0.05, 30],
  'detection.leadInSec': [0, 5],
  'detection.leadOutSec': [0, 5],
  'detection.minKeepSec': [0, 10],
};

/* ------------------------------------------------------------------ */
/*  Paths                                                             */
/* ------------------------------------------------------------------ */

// In development (`electron .`) settings live in <repo>/settings — exactly
// where they're wanted, hand-editable and tracked. In a packaged build the app
// directory is read-only (inside app.asar), so fall back to a writable per-user
// location. Resolved lazily so a plain `node require` (smoke tests) still works.
let _dir = null;
function settingsDir() {
  if (_dir) return _dir;
  let app = null;
  try { ({ app } = require('electron')); } catch { /* not running inside Electron */ }
  _dir = app && app.isPackaged
    ? path.join(app.getPath('userData'), 'settings')
    : path.join(__dirname, '..', '..', 'settings');
  return _dir;
}
function defaultFile() { return path.join(settingsDir(), 'default.dom'); }
function activeFile() { return path.join(settingsDir(), 'silence-cutter.dom'); }

/* ------------------------------------------------------------------ */
/*  Merge + validation                                                */
/* ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Fresh, unfrozen deep copy of DEFAULTS (DEFAULTS is frozen and must never be
// mutated). DEFAULTS is JSON-safe, so a round-trip is a clean deep clone.
function defaultsClone() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

// Recursively merge `over` onto `base`. Only plain objects merge; for any leaf
// (primitive or type mismatch) `over` wins when provided, else `base` is kept.
function deepMerge(base, over) {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base };
    for (const key of Object.keys(over)) {
      out[key] = deepMerge(base[key], over[key]);
    }
    return out;
  }
  return over === undefined ? base : over;
}

function clampNumber(value, [min, max], fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Coerce a settings object into something safe: fill gaps from defaults,
// restore missing/corrupt groups, clamp numbers, reject bad enum values.
function sanitize(input) {
  // Base is an unfrozen clone, so every field below is safe to overwrite.
  const merged = deepMerge(defaultsClone(), isPlainObject(input) ? input : {});

  for (const group of GROUPS) {
    if (!isPlainObject(merged[group])) merged[group] = defaultsClone()[group];
  }

  for (const [dotted, range] of Object.entries(RANGES)) {
    const [group, key] = dotted.split('.');
    merged[group][key] = clampNumber(merged[group][key], range, DEFAULTS[group][key]);
  }

  for (const [dotted, allowed] of Object.entries(ENUMS)) {
    const [group, key] = dotted.split('.');
    if (!allowed.includes(merged[group][key])) merged[group][key] = DEFAULTS[group][key];
  }

  if (typeof merged.app.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(merged.app.accent)) {
    merged.app.accent = DEFAULTS.app.accent;
  }
  if (typeof merged.app.ffmpegPath !== 'string') merged.app.ffmpegPath = '';
  if (typeof merged.output.suffix !== 'string') merged.output.suffix = DEFAULTS.output.suffix;

  return merged;
}

/* ------------------------------------------------------------------ */
/*  Disk I/O                                                          */
/* ------------------------------------------------------------------ */

function ensureDir() {
  const dir = settingsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDom(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${path.basename(file)}: ${err.message}`);
  }
}

function writeDom(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function getDefaults() {
  try {
    if (fs.existsSync(defaultFile())) return sanitize(readDom(defaultFile()));
  } catch (err) {
    console.warn('[settings] default.dom unreadable, using built-in defaults:', err.message);
  }
  return sanitize({});
}

function load() {
  ensureDir();
  const defaults = getDefaults();

  if (!fs.existsSync(defaultFile())) writeDom(defaultFile(), defaults);
  if (!fs.existsSync(activeFile())) writeDom(activeFile(), defaults);

  try {
    return sanitize(deepMerge(defaults, readDom(activeFile())));
  } catch (err) {
    console.warn('[settings] silence-cutter.dom unreadable, restoring defaults:', err.message);
    writeDom(activeFile(), defaults);
    return defaults;
  }
}

function save(partial) {
  ensureDir();
  const merged = sanitize(deepMerge(load(), partial || {}));
  writeDom(activeFile(), merged);
  return merged;
}

function reset() {
  ensureDir();
  const defaults = getDefaults();
  writeDom(activeFile(), defaults);
  return defaults;
}

function importFrom(filePath) {
  const raw = readDom(filePath); // throws a friendly Error — callers catch it
  return save(raw);
}

function exportTo(filePath, current) {
  const clean = sanitize(current || load());
  writeDom(filePath, clean);
  return filePath;
}

module.exports = {
  get SETTINGS_DIR() { return settingsDir(); },
  get ACTIVE_FILE() { return activeFile(); },
  get DEFAULT_FILE() { return defaultFile(); },
  DEFAULTS,
  load,
  save,
  reset,
  importFrom,
  exportTo,
  getDefaults,
  sanitize,
};
