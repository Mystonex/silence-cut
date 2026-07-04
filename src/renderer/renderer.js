'use strict';

/* Silence Cutter renderer — talks to the main process only through window.silenceCutter. */

const api = window.silenceCutter;

const state = {
  settings: null,
  video: null, // { path, name, ext, size }
  analysis: null, // { duration, segments, peaks, thresholdDb }
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
/*  Cut planning — the single source of truth                          */
/*                                                                     */
/*  The math lives in cutplan.js (window.CutPlan) so the exact same    */
/*  planning drives the on-screen stats, the exported cut list, and    */
/*  the rendered video — the preview the user approves is what ships.  */
/* ------------------------------------------------------------------ */

function computePlan() {
  const a = state.analysis;
  if (!a) return { removed: [], keep: [], removedTotal: 0, keepTotal: 0, dur: 0 };
  return CutPlan.planCuts(cutSegments(), state.settings.detection, a.duration);
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

// Live preview while dragging sliders (no disk write until Save).
function onFormInput() {
  state.settings = readForm();
  fillForm(state.settings); // refresh the <em> value labels
  applyTheme(state.settings.app.theme);
  applyAccent(state.settings.app.accent);
  if (state.analysis) { renderStats(); paintSegments(); renderSegmentList(); }
}

/* ------------------------------------------------------------------ */
/*  Video + analysis                                                  */
/* ------------------------------------------------------------------ */

function loadVideo(v) {
  state.video = v;
  state.analysis = null;
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
  clearWaveform();
  renderStats();
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

    $('#file-sub').textContent = [
      state.video.ext ? state.video.ext.toUpperCase() : '',
      fmtBytes(state.video.size),
      fmtTime(result.duration),
      `${result.thresholdDb} dB`,
    ].filter(Boolean).join('  ·  ');
    renderAll();
    $('#btn-export-cutlist').disabled = false;
    $('#btn-export-video').disabled = false;
    const n = result.segments.length;
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

function drawWaveform() {
  if (!state.analysis) return;
  const peaks = state.analysis.peaks;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  clearWaveform();

  const mid = h / 2;
  const barW = w / peaks.length;
  const accentStr = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const a = hexToRgb(accentStr) || { r: 110, g: 231, b: 255 };

  for (let i = 0; i < peaks.length; i++) {
    const x = i * barW;
    const amp = peaks[i];
    const barH = Math.max(1, amp * (h * 0.9));
    // Quiet samples render dim; loud samples pick up the accent.
    ctx.fillStyle = amp < 0.12
      ? 'rgba(150, 160, 185, 0.25)'
      : `rgba(${a.r}, ${a.g}, ${a.b}, ${0.35 + amp * 0.5})`;
    ctx.fillRect(x, mid - barH / 2, Math.max(0.6, barW - 0.4), barH);
  }
}

function paintSegments() {
  const layer = $('#seg-layer');
  layer.innerHTML = '';
  const a = state.analysis;
  if (!a) return;
  for (const seg of a.segments) {
    const el = document.createElement('div');
    el.className = 'seg' + (seg.cut ? '' : ' kept');
    el.style.left = `${(seg.start / a.duration) * 100}%`;
    el.style.width = `${((seg.end - seg.start) / a.duration) * 100}%`;
    el.title = `${fmtClock(seg.start)} – ${fmtClock(seg.end)} (${(seg.end - seg.start).toFixed(1)}s)`;
    el.addEventListener('click', () => toggleSegment(seg.id));
    layer.appendChild(el);
  }
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
    list.innerHTML = '<li class="seg-item"><span class="dot" style="background:var(--keep)"></span><span class="grow">No dead air found with these settings. Try a higher threshold.</span></li>';
    return;
  }
  a.segments.forEach((seg) => {
    const li = document.createElement('li');
    li.className = 'seg-item' + (seg.cut ? '' : ' kept');
    const dur = (seg.end - seg.start).toFixed(1);
    li.innerHTML = `
      <span class="dot"></span>
      <span class="rng">${fmtClock(seg.start)} – ${fmtClock(seg.end)}</span>
      <span class="dur">${dur}s</span>
      <span class="grow"></span>
      <span class="tag">${seg.cut ? 'cut' : 'keep'}</span>
      <button class="toggle">${seg.cut ? 'Keep' : 'Cut'}</button>`;
    li.querySelector('.toggle').addEventListener('click', () => toggleSegment(seg.id));
    list.appendChild(li);
  });
}

function renderAll() {
  drawWaveform();
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

async function init() {
  wireEvents();
  wireDragDrop();
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
