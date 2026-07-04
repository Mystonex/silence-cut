'use strict';

/* Silence Cutter renderer — talks to the main process only through window.silenceCutter. */

const api = window.silenceCutter;

const state = {
  settings: null,
  video: null, // { path, name, ext, size }
  analysis: null, // { duration, segments, peaks, thresholdDb, silences }
  selectedSeg: null, // id of the currently selected cut (for keyboard delete)
  nextSegId: 0, // monotonic id source for manual + auto cuts
  playT: null, // playhead time (seconds)
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function fmtClock(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${r}`;
}

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

let toastTimer = null;
function toast(message, kind = '') {
  const host = $('#toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

function setStatus(text) { $('#status').textContent = text; }

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* ------------------------------------------------------------------ */
/*  dB scale — maps waveform amplitude to a fixed dBFS axis            */
/* ------------------------------------------------------------------ */

const DB_FLOOR = -60; // bottom of the visible scale
const DB_CEIL = 0;    // top (digital full scale)
const DB_TICKS = [0, -12, -24, -36, -48, -60];

// Absolute peak amplitude [0,1] → dBFS. 0 maps well below the floor.
function ampToDb(amp) { return amp > 0 ? 20 * Math.log10(amp) : DB_FLOOR - 40; }
// dBFS → fraction of the scale height, 0 at the floor … 1 at the ceiling.
function dbToFrac(db) { return clamp((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR), 0, 1); }

/* ------------------------------------------------------------------ */
/*  Cut planning — the single source of truth                          */
/*                                                                     */
/*  The math lives in cutplan.js (window.CutPlan) so the exact same    */
/*  planning drives the on-screen stats, the exported cut list, and    */
/*  the rendered video — the preview the user approves is what ships.  */
/* ------------------------------------------------------------------ */

function computePlan() {
  const a = state.analysis;
  if (!a) return { removed: [], keep: [], removedTotal: 0, keepTotal: 0, dur: 0 };
  // Segments already ARE concrete cut regions (padding was baked in at Analyze),
  // so plan without re-padding — just merge overlaps + apply min-keep.
  return CutPlan.planFromCuts(cutSegments(), state.settings.detection.minKeepSec, a.duration);
}

/* ------------------------------------------------------------------ */
/*  Settings <-> form                                                 */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('theme-dark', dark);
  document.body.classList.toggle('theme-light', !dark);
}

function applyAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  const rgb = hexToRgb(hex);
  if (rgb) {
    document.documentElement.style.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`);
    document.documentElement.style.setProperty('--accent-line', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.42)`);
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function fillForm(s) {
  $('#s-threshold').value = s.detection.thresholdDb;
  $('#v-threshold').textContent = `${s.detection.thresholdDb} dB`;
  $('#s-minsil').value = s.detection.minSilenceSec;
  $('#v-minsil').textContent = `${s.detection.minSilenceSec} s`;
  $('#s-leadin').value = s.detection.leadInSec;
  $('#v-leadin').textContent = `${s.detection.leadInSec} s`;
  $('#s-leadout').value = s.detection.leadOutSec;
  $('#v-leadout').textContent = `${s.detection.leadOutSec} s`;
  $('#s-minkeep').value = s.detection.minKeepSec;
  $('#v-minkeep').textContent = `${s.detection.minKeepSec} s`;

  $('#s-mode').value = s.output.mode;
  $('#s-format').value = s.output.format;
  $('#s-suffix').value = s.output.suffix;

  $('#s-theme').value = s.app.theme;
  $('#s-accent').value = s.app.accent;
  $('#s-ffmpeg').value = s.app.ffmpegPath;
}

// Read the form into a fresh settings object (based on current state).
function readForm() {
  const s = structuredClone(state.settings);
  s.detection.thresholdDb = Number($('#s-threshold').value);
  s.detection.minSilenceSec = Number($('#s-minsil').value);
  s.detection.leadInSec = Number($('#s-leadin').value);
  s.detection.leadOutSec = Number($('#s-leadout').value);
  s.detection.minKeepSec = Number($('#s-minkeep').value);
  s.output.mode = $('#s-mode').value;
  s.output.format = $('#s-format').value;
  s.output.suffix = $('#s-suffix').value;
  s.app.theme = $('#s-theme').value;
  s.app.accent = $('#s-accent').value;
  s.app.ffmpegPath = $('#s-ffmpeg').value;
  return s;
}

// Live preview while dragging sliders (no disk write until Save). Threshold and
// accent restyle the waveform + threshold line live; min-keep updates the plan.
// Lead-in/out are baked at Analyze, so they take effect on the next Analyze.
function onFormInput() {
  state.settings = readForm();
  fillForm(state.settings); // refresh the <em> value labels
  applyTheme(state.settings.app.theme);
  applyAccent(state.settings.app.accent);
  if (state.analysis) { drawWaveform(); updateThresholdLine(); renderStats(); }
}

/* ------------------------------------------------------------------ */
/*  Video + analysis                                                  */
/* ------------------------------------------------------------------ */

async function loadVideo(v) {
  state.video = v;
  state.analysis = null;
  state.selectedSeg = null;
  state.nextSegId = 0;
  state.playT = null;
  $('#dropzone').classList.add('hidden');
  $('#editor').classList.add('hidden');
  $('#file-name').textContent = v.name;
  $('#file-sub').textContent = [v.ext ? v.ext.toUpperCase() : '', fmtBytes(v.size), 'not analyzed yet']
    .filter(Boolean).join('  ·  ');
  $('#btn-analyze').disabled = false;
  $('#btn-export-cutlist').disabled = true;
  $('#btn-export-video').disabled = true;
  setStatus(`Loaded ${v.name}. Hit Analyze to find dead air.`);
  toast(`Imported ${v.name}`, 'ok');
  // Reveal the editor shell so the user sees where results will appear.
  $('#editor').classList.remove('hidden');
  $('#segment-list').innerHTML = '<li class="seg-item"><span class="dot" style="background:var(--text-faint)"></span><span class="grow">No analysis yet — press <strong style="margin:0 4px">Analyze</strong> to scan for silence.</span></li>';
  $('#seg-layer').innerHTML = '';
  $('#threshold-line').hidden = true;
  hidePreview();
  hidePlayhead();
  clearWaveform();
  renderStats();

  // Load the source into the muted <video> that drives the frame preview.
  // Reset any in-flight seek from the previous clip — pv.load() below aborts it
  // without firing 'seeked', which would otherwise strand the preview.
  resetSeekState();
  previewSupported = true;
  $('#preview').classList.remove('unsupported');
  const pv = $('#preview-video');
  try {
    const url = await api.toFileUrl(v.path);
    if (url) { pv.src = url; pv.load(); }
    else pv.removeAttribute('src');
  } catch { pv.removeAttribute('src'); }
}

async function importVideo() {
  const res = await api.importVideo();
  if (!res || res.canceled) return;
  loadVideo(res);
}

async function analyze() {
  if (progressActive) return; // a job is already running (guards menu ⌘R re-trigger)
  if (!state.video) { toast('Import a video first.'); return; }
  setStatus('Analyzing audio for dead air…');
  $('#btn-analyze').disabled = true;
  showProgress('Analyzing audio…', state.video.name, 'analyze');
  try {
    const result = await api.runAnalysis({ videoPath: state.video.path, settings: state.settings });
    if (result && result.busy) { setStatus('Another job is already running.'); return; }
    if (!result || result.canceled) {
      setStatus('Analysis canceled.');
      toast('Analysis canceled');
      return;
    }
    state.analysis = result;

    if (result.hasAudio === false) {
      $('#file-sub').textContent = [
        state.video.ext ? state.video.ext.toUpperCase() : '',
        fmtBytes(state.video.size),
        fmtTime(result.duration),
        'no audio track',
      ].filter(Boolean).join('  ·  ');
      renderAll();
      $('#btn-export-cutlist').disabled = true;
      $('#btn-export-video').disabled = true;
      setStatus('No audio track in this file — nothing to detect.');
      toast('No audio track found in this file.', 'err');
      return;
    }

    // Turn the raw detected silences into concrete, editable cut regions by
    // baking in the lead-in/out padding now — so the blocks the user drags ARE
    // exactly what gets removed.
    const silences = (result.segments || []).map((s) => ({ start: s.start, end: s.end }));
    state.analysis.silences = silences;
    const cuts = CutPlan.deriveCuts(silences, state.settings.detection, result.duration);
    state.nextSegId = 0;
    state.selectedSeg = null;
    state.analysis.segments = cuts.map((r) => ({
      id: state.nextSegId++, start: r.start, end: r.end, cut: true, source: 'auto',
    }));

    $('#file-sub').textContent = [
      state.video.ext ? state.video.ext.toUpperCase() : '',
      fmtBytes(state.video.size),
      fmtTime(result.duration),
      `${result.thresholdDb} dB`,
    ].filter(Boolean).join('  ·  ');
    renderAll();
    $('#btn-export-cutlist').disabled = false;
    $('#btn-export-video').disabled = false;
    const n = state.analysis.segments.length;
    setStatus(`Found ${n} dead ${n === 1 ? 'spot' : 'spots'} at ${result.thresholdDb} dB.`);
    toast(`${n} dead ${n === 1 ? 'spot' : 'spots'} detected`, n ? 'ok' : '');
  } catch (err) {
    setStatus('Analysis failed.');
    toast(`Analysis failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
    $('#btn-analyze').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Rendering: stats, waveform, segments                              */
/* ------------------------------------------------------------------ */

function cutSegments() {
  return state.analysis ? state.analysis.segments.filter((s) => s.cut) : [];
}

function renderStats() {
  const a = state.analysis;
  if (!a) {
    $('#stat-cuts').textContent = '0';
    $('#stat-removed').textContent = '0:00';
    $('#stat-result').textContent = fmtTime(0);
    return;
  }
  const plan = computePlan();
  $('#stat-cuts').textContent = String(cutSegments().length);
  $('#stat-removed').textContent = fmtTime(plan.removedTotal);
  $('#stat-result').textContent = fmtTime(a.duration - plan.removedTotal);
}

const canvas = $('#waveform');
const ctx = canvas.getContext('2d');

function clearWaveform() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}

// The waveform is drawn against the dB axis: each bar rises from the bottom
// (silence, −60 dB) up to its level. Bars at/below the silence threshold render
// muted so you can see which audio counts as dead air.
function drawWaveform() {
  if (!state.analysis) return;
  const peaks = state.analysis.peaks;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  clearWaveform();

  // Read theme-aware colors from <body> (the theme class lives there, so its
  // overrides resolve; :root defaults inherit otherwise).
  const cs = getComputedStyle(document.body);
  const a = hexToRgb(cs.getPropertyValue('--accent').trim()) || { r: 110, g: 231, b: 255 };
  const gridColor = cs.getPropertyValue('--wave-grid').trim() || 'rgba(255,255,255,0.05)';
  const mutedColor = cs.getPropertyValue('--wave-muted').trim() || 'rgba(150,160,185,0.32)';
  const threshDb = state.settings.detection.thresholdDb;

  // Horizontal dB gridlines (clamp so the -60 floor line stays on-canvas).
  ctx.lineWidth = 1;
  ctx.strokeStyle = gridColor;
  for (const db of DB_TICKS) {
    const y = Math.min(h - 0.5, Math.round(h * (1 - dbToFrac(db))) + 0.5);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const barW = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const x = i * barW;
    const amp = peaks[i];
    const db = ampToDb(amp);
    const frac = dbToFrac(db);
    const barH = Math.max(amp > 0 ? 1 : 0, frac * h);
    if (db <= threshDb) {
      ctx.fillStyle = mutedColor; // silence — muted
    } else {
      ctx.fillStyle = `rgba(${a.r}, ${a.g}, ${a.b}, ${0.4 + frac * 0.5})`;
    }
    ctx.fillRect(x, h - barH, Math.max(0.6, barW - 0.4), barH);
  }
}

function renderDbScale() {
  const scale = $('#db-scale');
  scale.innerHTML = '';
  for (const db of DB_TICKS) {
    const el = document.createElement('span');
    el.className = 'db-tick';
    el.style.top = `${(1 - dbToFrac(db)) * 100}%`;
    el.textContent = db === 0 ? '0 dB' : String(db);
    scale.appendChild(el);
  }
}

function updateThresholdLine() {
  const line = $('#threshold-line');
  if (!state.analysis) { line.hidden = true; return; }
  const db = state.settings.detection.thresholdDb;
  line.style.top = `${(1 - dbToFrac(db)) * 100}%`;
  line.querySelector('.threshold-tag').textContent = `${db} dB`;
  line.hidden = false;
}

/* ------------------------------------------------------------------ */
/*  Timeline coordinates, playhead, scrub                             */
/* ------------------------------------------------------------------ */

const timelineEl = $('#timeline');

// Pointer client-X → time (seconds), clamped to the media.
function xToTime(clientX) {
  if (!state.analysis) return 0;
  const rect = timelineEl.getBoundingClientRect();
  return clamp((clientX - rect.left) / rect.width, 0, 1) * state.analysis.duration;
}

function timePct(t) {
  return state.analysis ? (t / state.analysis.duration) * 100 : 0;
}

function setPlayhead(t) {
  if (!state.analysis) return;
  state.playT = t;
  const ph = $('#playhead');
  ph.style.left = `${timePct(t)}%`;
  ph.hidden = false;
}
function hidePlayhead() { state.playT = null; $('#playhead').hidden = true; }

function showScrub(t) {
  const s = $('#scrub');
  s.style.left = `${timePct(t)}%`;
  s.hidden = false;
}
function hideScrub() { $('#scrub').hidden = true; }

/* ------------------------------------------------------------------ */
/*  Video frame preview (F1)                                          */
/* ------------------------------------------------------------------ */

// Coalesced seeking: never queue more than one pending seek on the <video>.
let seekPending = null;
let seeking = false;
let seekTimer = null;
// Some containers/codecs (e.g. HEVC, certain MKV) can't be decoded by the
// <video> element even though ffmpeg handles them — degrade to a timestamp-only
// bubble rather than a black box.
let previewSupported = true;

// Reset seek/watchdog state so a stuck `seeking` flag can never freeze the
// preview (e.g. across a re-import that aborts an in-flight seek).
function resetSeekState() {
  seekPending = null;
  seeking = false;
  if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
}

function pumpSeek() {
  const v = $('#preview-video');
  if (seekPending == null || seeking || v.readyState < 1) return;
  const target = clamp(seekPending, 0, v.duration || seekPending);
  seekPending = null;
  // Assigning currentTime to the value it already holds is a no-op that fires no
  // 'seeked' event — which would strand `seeking` true forever. Skip it.
  if (Math.abs(target - v.currentTime) < 1e-3) return;
  seeking = true;
  // Watchdog: recover if a genuine 'seeked' is ever missed (decode stall).
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = setTimeout(() => { seeking = false; seekTimer = null; pumpSeek(); }, 500);
  try { v.currentTime = target; } catch { seeking = false; if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; } }
}

let previewRaf = null;
let previewArg = null;
function schedulePreview(t, clientX) {
  previewArg = { t, clientX };
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = null;
    if (previewArg) previewAt(previewArg.t, previewArg.clientX);
  });
}

function previewAt(t, clientX) {
  if (!state.video || !state.analysis) return;
  const pv = $('#preview-video');
  if (!pv.getAttribute('src')) return; // video not loadable — skip preview
  if (previewSupported) { seekPending = t; pumpSeek(); }

  const prev = $('#preview');
  $('#preview-time').textContent = previewSupported ? fmtClock(t) : `${fmtClock(t)} · no frame preview`;
  prev.hidden = false;
  prev.setAttribute('aria-hidden', 'false');

  // Fixed (viewport) positioning so no ancestor overflow can clip it. Prefer
  // above the timeline; drop below if there isn't room.
  const tlRect = timelineEl.getBoundingClientRect();
  const pw = prev.offsetWidth || 224;
  const phgt = prev.offsetHeight || 150;
  const left = clamp(clientX - pw / 2, 8, window.innerWidth - pw - 8);
  let top = tlRect.top - phgt - 10;
  if (top < 8) top = tlRect.bottom + 10;
  prev.style.left = `${left}px`;
  prev.style.top = `${top}px`;
}

function hidePreview() {
  // Cancel any queued preview frame so it can't re-show the bubble after leave.
  if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
  previewArg = null;
  const prev = $('#preview');
  prev.hidden = true;
  prev.setAttribute('aria-hidden', 'true');
}

const MIN_SEG = 0.05; // shortest editable cut (seconds)

function segLabelText(seg) {
  return `${fmtClock(seg.start)}–${fmtClock(seg.end)} · ${(seg.end - seg.start).toFixed(1)}s`;
}

function paintSegments() {
  const layer = $('#seg-layer');
  layer.innerHTML = '';
  const a = state.analysis;
  if (!a) return;
  for (const seg of a.segments) layer.appendChild(makeSegEl(seg));
}

function makeSegEl(seg) {
  const a = state.analysis;
  const el = document.createElement('div');
  el.className = 'seg' + (seg.cut ? '' : ' kept') + (seg.id === state.selectedSeg ? ' selected' : '');
  el.dataset.id = String(seg.id);
  el.style.left = `${(seg.start / a.duration) * 100}%`;
  el.style.width = `${((seg.end - seg.start) / a.duration) * 100}%`;

  const lh = document.createElement('div'); lh.className = 'seg-handle left';
  const rh = document.createElement('div'); rh.className = 'seg-handle right';
  const del = document.createElement('button');
  del.className = 'seg-del'; del.type = 'button'; del.title = 'Delete cut'; del.setAttribute('aria-label', 'Delete cut');
  del.textContent = '✕';
  const label = document.createElement('div'); label.className = 'seg-label'; label.textContent = segLabelText(seg);
  el.append(lh, rh, del, label);

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteSegment(seg.id); });
  lh.addEventListener('pointerdown', (e) => startSegDrag(e, seg, 'resize-l', el));
  rh.addEventListener('pointerdown', (e) => startSegDrag(e, seg, 'resize-r', el));
  el.addEventListener('pointerdown', (e) => {
    if (e.target === lh || e.target === rh || e.target === del) return;
    startSegDrag(e, seg, 'move', el);
  });
  return el;
}

/* ---- segment drag (resize edges / move body) --------------------- */

let drag = null;

function startSegDrag(e, seg, mode, el) {
  e.preventDefault();
  e.stopPropagation();
  selectSegment(seg.id);
  drag = { seg, mode, el, startX: e.clientX, origStart: seg.start, origEnd: seg.end, width: seg.end - seg.start, moved: false };
  el.classList.add('dragging');
  try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }

  const move = (ev) => onSegDragMove(ev);
  const up = (ev) => {
    el.classList.remove('dragging');
    try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    finishSegDrag();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function onSegDragMove(ev) {
  if (!drag || !state.analysis) return;
  const a = state.analysis;
  const rect = timelineEl.getBoundingClientRect();
  const dt = ((ev.clientX - drag.startX) / rect.width) * a.duration;
  if (Math.abs(ev.clientX - drag.startX) > 2) drag.moved = true;
  const seg = drag.seg;
  let previewT;

  if (drag.mode === 'resize-l') {
    seg.start = clamp(drag.origStart + dt, 0, drag.origEnd - MIN_SEG);
    previewT = seg.start;
  } else if (drag.mode === 'resize-r') {
    seg.end = clamp(drag.origEnd + dt, drag.origStart + MIN_SEG, a.duration);
    previewT = seg.end;
  } else {
    const ns = clamp(drag.origStart + dt, 0, a.duration - drag.width);
    seg.start = ns;
    seg.end = ns + drag.width;
    previewT = seg.start;
  }

  drag.el.style.left = `${(seg.start / a.duration) * 100}%`;
  drag.el.style.width = `${((seg.end - seg.start) / a.duration) * 100}%`;
  drag.el.querySelector('.seg-label').textContent = segLabelText(seg);
  showScrub(previewT);
  schedulePreview(previewT, ev.clientX);
  scheduleStats();
}

function finishSegDrag() {
  if (!drag) return;
  drag = null;
  hideScrub();
  hidePreview(); // drag ended over the .seg, so the timeline won't hide it for us
  if (!state.analysis) return; // source was replaced mid-drag — nothing to re-render
  state.analysis.segments.sort((x, y) => x.start - y.start);
  paintSegments();
  renderSegmentList();
  renderStats();
}

let statsRaf = null;
function scheduleStats() {
  if (statsRaf) return;
  statsRaf = requestAnimationFrame(() => { statsRaf = null; renderStats(); });
}

/* ---- add / delete / select cuts ---------------------------------- */

function addCut(t) {
  const a = state.analysis;
  if (!a) return;
  const dur = a.duration;
  let start = clamp(t, 0, dur);
  let end = Math.min(start + 1.0, dur);
  if (end - start < 0.2) { start = Math.max(0, dur - 1.0); end = dur; }
  const seg = { id: state.nextSegId++, start, end, cut: true, source: 'manual' };
  a.segments.push(seg);
  a.segments.sort((x, y) => x.start - y.start);
  selectSegment(seg.id);
  paintSegments();
  renderSegmentList();
  renderStats();
  toast('Cut added — drag its edges to fit.', 'ok');
}

function deleteSegment(id) {
  const a = state.analysis;
  if (!a) return;
  const i = a.segments.findIndex((s) => s.id === id);
  if (i === -1) return;
  a.segments.splice(i, 1);
  if (state.selectedSeg === id) state.selectedSeg = null;
  paintSegments();
  renderSegmentList();
  renderStats();
}

function selectSegment(id) {
  state.selectedSeg = id;
  $$('#seg-layer .seg').forEach((el) => el.classList.toggle('selected', Number(el.dataset.id) === id));
  $$('#segment-list .seg-item').forEach((li) => li.classList.toggle('sel', Number(li.dataset.id) === id));
}

function renderRuler() {
  const ruler = $('#ruler');
  ruler.innerHTML = '';
  const a = state.analysis;
  if (!a) return;
  const target = 8;
  const rawStep = a.duration / target;
  const nice = [15, 30, 60, 120, 300, 600, 900, 1800];
  const step = nice.find((n) => n >= rawStep) || 3600;
  for (let t = 0; t <= a.duration; t += step) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${(t / a.duration) * 100}%`;
    tick.textContent = fmtTime(t);
    ruler.appendChild(tick);
  }
}

function renderSegmentList() {
  const list = $('#segment-list');
  const a = state.analysis;
  if (!a) return;
  list.innerHTML = '';
  if (a.segments.length === 0) {
    list.innerHTML = '<li class="seg-item"><span class="dot" style="background:var(--keep)"></span><span class="grow">No dead air with these settings. Raise the threshold and re-analyze, or double-click the timeline to add a cut.</span></li>';
    return;
  }
  a.segments.forEach((seg) => {
    const li = document.createElement('li');
    li.className = 'seg-item' + (seg.cut ? '' : ' kept') + (seg.id === state.selectedSeg ? ' sel' : '');
    li.dataset.id = String(seg.id);
    const dur = (seg.end - seg.start).toFixed(1);
    li.innerHTML = `
      <span class="dot"></span>
      <span class="rng">${fmtClock(seg.start)} – ${fmtClock(seg.end)}</span>
      <span class="dur">${dur}s</span>
      <span class="grow"></span>
      <span class="tag">${seg.cut ? 'cut' : 'keep'}${seg.source === 'manual' ? ' · manual' : ''}</span>
      <button class="toggle">${seg.cut ? 'Keep' : 'Cut'}</button>
      <button class="row-del" title="Delete cut" aria-label="Delete cut">✕</button>`;
    li.querySelector('.toggle').addEventListener('click', (e) => { e.stopPropagation(); toggleSegment(seg.id); });
    li.querySelector('.row-del').addEventListener('click', (e) => { e.stopPropagation(); deleteSegment(seg.id); });
    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectSegment(seg.id);
      setPlayhead((seg.start + seg.end) / 2);
    });
    list.appendChild(li);
  });
}

function renderAll() {
  renderDbScale();
  drawWaveform();
  updateThresholdLine();
  paintSegments();
  renderRuler();
  renderSegmentList();
  renderStats();
}

function toggleSegment(id) {
  const seg = state.analysis?.segments.find((s) => s.id === id);
  if (!seg) return;
  seg.cut = !seg.cut;
  paintSegments();
  renderSegmentList();
  renderStats();
}

function setAllCut(cut) {
  if (!state.analysis) return;
  state.analysis.segments.forEach((s) => { s.cut = cut; });
  paintSegments();
  renderSegmentList();
  renderStats();
}

/* ------------------------------------------------------------------ */
/*  Settings drawer                                                   */
/* ------------------------------------------------------------------ */

function openSettings() {
  $('#scrim').hidden = false;
  requestAnimationFrame(() => $('#scrim').classList.add('show'));
  $('#settings-drawer').classList.add('open');
  $('#settings-drawer').setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  $('#scrim').classList.remove('show');
  $('#settings-drawer').classList.remove('open');
  $('#settings-drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('#scrim').hidden = true; }, 260);
}

function toggleSettings() {
  if ($('#settings-drawer').classList.contains('open')) closeSettings();
  else openSettings();
}

async function saveSettings() {
  const saved = await api.saveSettings(readForm());
  state.settings = saved;
  fillForm(saved);
  toast('Settings saved to silence-cutter.dom', 'ok');
  setStatus('Settings saved.');
}

async function resetSettings() {
  const defaults = await api.resetSettings();
  state.settings = defaults;
  fillForm(defaults);
  applyTheme(defaults.app.theme);
  applyAccent(defaults.app.accent);
  if (state.analysis) renderAll();
  toast('Settings reset to defaults', 'ok');
}

async function importSettings() {
  const res = await api.importSettings();
  if (!res || res.canceled) return;
  if (res.error) { toast(res.error, 'err'); return; }
  state.settings = res.settings;
  fillForm(res.settings);
  applyTheme(res.settings.app.theme);
  applyAccent(res.settings.app.accent);
  if (state.analysis) renderAll();
  toast('Settings imported', 'ok');
}

async function exportSettings() {
  const res = await api.exportSettings(readForm());
  if (!res || res.canceled) return;
  if (res.error) { toast(res.error, 'err'); return; }
  toast('Settings exported', 'ok');
}

/* ------------------------------------------------------------------ */
/*  Export                                                            */
/* ------------------------------------------------------------------ */

async function exportCutlist() {
  if (!state.analysis) { toast('Analyze a video first.'); return; }
  const plan = computePlan();
  const cuts = plan.removed.map((r) => ({
    start: Number(r.start.toFixed(3)),
    end: Number(r.end.toFixed(3)),
    duration: Number((r.end - r.start).toFixed(3)),
  }));

  const res = await api.exportCutlist({
    videoPath: state.video.path,
    videoName: state.video.name,
    duration: state.analysis.duration,
    settings: state.settings,
    cuts,
  });
  if (!res || res.canceled) return;
  if (res.error) { toast(res.error, 'err'); return; }
  toast(`Cut list saved (${res.count} cuts)`, 'ok');
  setStatus(`Exported cut list → ${res.path}`);
}

async function exportVideo() {
  if (progressActive) return; // a job is already running (guards menu ⌘E re-trigger)
  if (!state.analysis) { toast('Analyze a video first.'); return; }
  if (state.analysis.hasAudio === false) { toast('No audio track — nothing to trim.', 'err'); return; }

  const plan = computePlan();
  if (plan.keep.length === 0) { toast('Everything is marked as a cut — nothing to keep.', 'err'); return; }

  showProgress('Rendering trimmed video…', 'Encoding with ffmpeg — this can take a while.', 'render');
  setStatus('Rendering trimmed video…');
  try {
    const res = await api.exportVideo({
      videoPath: state.video.path,
      videoName: state.video.name,
      duration: state.analysis.duration,
      hasAudio: state.analysis.hasAudio,
      keep: plan.keep.map((r) => ({ start: Number(r.start.toFixed(3)), end: Number(r.end.toFixed(3)) })),
      settings: state.settings,
    });
    if (!res || res.canceled) {
      setStatus(res && res.reason === 'canceled' ? 'Render canceled.' : 'Ready.');
      if (res && res.reason === 'canceled') toast('Render canceled');
      return;
    }
    if (res.error) { toast(res.error, 'err'); setStatus('Render failed.'); return; }
    toast('Trimmed video saved', 'ok');
    setStatus(`Exported trimmed video → ${res.path}`);
    api.revealPath(res.path);
  } catch (err) {
    setStatus('Render failed.');
    toast(`Render failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

/* ------------------------------------------------------------------ */
/*  Drag & drop                                                       */
/* ------------------------------------------------------------------ */

function wireDragDrop() {
  const dz = $('#dropzone');
  const VIDEO_RE = /\.(mp4|mkv|mov|webm|avi|m4v|flv|ts|wmv)$/i;

  ['dragenter', 'dragover'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!$('#dropzone').classList.contains('hidden')) dz.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      dz.classList.remove('drag-over');
    })
  );
  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!VIDEO_RE.test(file.name)) { toast('That doesn’t look like a video file.', 'err'); return; }
    const path = (api.getPathForFile && api.getPathForFile(file)) || file.path || '';
    if (!path) { toast('Couldn’t resolve that file’s path — use Import instead.', 'err'); return; }
    loadVideo({
      path,
      name: file.name,
      ext: (file.name.split('.').pop() || '').toLowerCase(),
      size: file.size,
    });
  });
}

/* ------------------------------------------------------------------ */
/*  About                                                             */
/* ------------------------------------------------------------------ */

async function showAbout() {
  const info = await api.getAppInfo().catch(() => null);
  if (info) $('#about-version').textContent = `v${info.version} · Electron ${info.electron}`;
  $('#about').hidden = false;
}
function hideAbout() { $('#about').hidden = true; }

/* ------------------------------------------------------------------ */
/*  Progress overlay (analysis + render)                              */
/* ------------------------------------------------------------------ */

let progressActive = false;
let progressPhase = null;

function showProgress(title, sub, phase) {
  progressActive = true;
  progressPhase = phase || null;
  $('#progress-title').textContent = title;
  $('#progress-sub').textContent = sub || '';
  $('#btn-cancel-job').disabled = false;
  $('#btn-cancel-job').textContent = 'Cancel';
  $('#progress').classList.remove('indeterminate');
  setProgress(0);
  $('#progress').hidden = false;
}

function setProgress(ratio) {
  const pct = Math.round(clamp(ratio, 0, 1) * 100);
  $('#progress-fill').style.width = `${pct}%`;
  $('#progress-pct').textContent = `${pct}%`;
}

function hideProgress() {
  progressActive = false;
  $('#progress').hidden = true;
}

async function cancelJob() {
  if (!progressActive) return;
  $('#btn-cancel-job').disabled = true;
  $('#btn-cancel-job').textContent = 'Canceling…';
  $('#progress-title').textContent = 'Canceling…';
  try { await api.cancelJob(); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                            */
/* ------------------------------------------------------------------ */

function wireEvents() {
  $('#btn-import').addEventListener('click', importVideo);
  $('#btn-import-2').addEventListener('click', importVideo);
  $('#btn-analyze').addEventListener('click', analyze);
  $('#btn-settings').addEventListener('click', toggleSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#scrim').addEventListener('click', closeSettings);

  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-reset-settings').addEventListener('click', resetSettings);
  $('#btn-import-settings').addEventListener('click', importSettings);
  $('#btn-export-settings').addEventListener('click', exportSettings);

  $('#btn-export-cutlist').addEventListener('click', exportCutlist);
  $('#btn-export-video').addEventListener('click', exportVideo);

  $('#btn-all-cut').addEventListener('click', () => setAllCut(true));
  $('#btn-all-keep').addEventListener('click', () => setAllCut(false));

  $('#btn-close-about').addEventListener('click', hideAbout);
  // Dismiss the About modal by clicking its backdrop (not the card itself).
  $('#about').addEventListener('click', (e) => { if (e.target === $('#about')) hideAbout(); });

  $('#btn-cancel-job').addEventListener('click', cancelJob);
  // Live progress from the running analysis / render job. Ignore stray events
  // whose phase doesn't match the overlay currently shown.
  api.onJobProgress((p) => {
    if (!progressActive || !p || typeof p.ratio !== 'number') return;
    if (progressPhase && p.phase && p.phase !== progressPhase) return;
    setProgress(p.ratio);
  });

  // Any settings control updates the live preview.
  $$('.drawer-body input, .drawer-body select').forEach((el) =>
    el.addEventListener('input', onFormInput)
  );

  // Redraw the canvas timeline on resize.
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (state.analysis) { drawWaveform(); } });
  });

  // Keyboard: Esc cancels a running job, else closes drawer / about.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (progressActive) cancelJob();
      else if (!$('#about').hidden) hideAbout();
      else if ($('#settings-drawer').classList.contains('open')) closeSettings();
      return;
    }
    // Delete / Backspace removes the selected cut (unless typing in a field or
    // mid-drag — deleting the dragged seg would strand the drag).
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const el = document.activeElement;
      const inField = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
      if (!inField && !drag && !progressActive && state.selectedSeg != null && state.analysis) {
        e.preventDefault();
        deleteSegment(state.selectedSeg);
      }
    }
  });

  // Native menu commands.
  api.onMenuCommand((cmd) => {
    switch (cmd) {
      case 'import-video': importVideo(); break;
      case 'analyze': analyze(); break;
      case 'toggle-settings': toggleSettings(); break;
      case 'export-cutlist': exportCutlist(); break;
      case 'export-video': exportVideo(); break;
      case 'import-settings': importSettings(); break;
      case 'export-settings': exportSettings(); break;
      case 'reset-settings': resetSettings(); break;
      case 'about': showAbout(); break;
      default: break;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Timeline interactions (hover preview, scrub, add cut)             */
/* ------------------------------------------------------------------ */

function wireTimeline() {
  const tl = timelineEl;
  const v = $('#preview-video');

  // Coalesced seeking for the preview.
  v.addEventListener('seeked', () => { seeking = false; if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; } pumpSeek(); });
  v.addEventListener('loadedmetadata', () => pumpSeek());
  // Codec the <video> can't decode → fall back to a timestamp-only bubble.
  v.addEventListener('error', () => { previewSupported = false; $('#preview').classList.add('unsupported'); });

  // Hover anywhere on the plot → frame preview + scrub line follow the cursor.
  tl.addEventListener('pointermove', (e) => {
    if (drag || !state.analysis) return;
    const t = xToTime(e.clientX);
    showScrub(t);
    schedulePreview(t, e.clientX);
  });
  tl.addEventListener('pointerleave', () => {
    if (!drag) { hideScrub(); hidePreview(); }
  });

  // Click/drag on empty timeline → move the playhead (and preview).
  tl.addEventListener('pointerdown', (e) => {
    if (!state.analysis || e.target.closest('.seg')) return;
    selectSegment(null);
    const seekTo = (ev) => { const t = xToTime(ev.clientX); setPlayhead(t); showScrub(t); schedulePreview(t, ev.clientX); };
    seekTo(e);
    const up = () => { document.removeEventListener('pointermove', seekTo); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', seekTo);
    document.addEventListener('pointerup', up);
  });

  // Double-click empty timeline → add a manual cut there.
  tl.addEventListener('dblclick', (e) => {
    if (!state.analysis || e.target.closest('.seg')) return;
    addCut(xToTime(e.clientX));
  });
}

async function init() {
  wireEvents();
  wireDragDrop();
  wireTimeline();
  try {
    state.settings = await api.loadSettings();
  } catch (err) {
    toast(`Could not load settings: ${err.message}`, 'err');
    return;
  }
  fillForm(state.settings);
  applyTheme(state.settings.app.theme);
  applyAccent(state.settings.app.accent);
  setStatus('Ready. Import a video to begin.');
}

window.addEventListener('DOMContentLoaded', init);
