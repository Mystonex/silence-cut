'use strict';

/*
 * Silence Cutter — ffmpeg engine.
 *
 * Pure Node (child_process + the ffmpeg/ffprobe static binaries). It deliberately
 * does NOT require 'electron', so the whole pipeline can be exercised headlessly
 * from a plain `node` script (see scripts/ + the smoke test).
 *
 * Three jobs:
 *   probe(input)                      → { duration, hasAudio, streams, ... }
 *   analyze(input, opts, onProgress)  → { duration, segments, peaks, hasAudio }
 *   renderCut(input, keep, out, opts) → writes a trimmed video, resolves { path }
 *
 * analyze() runs a SINGLE ffmpeg pass that both detects silence (silencedetect)
 * and decodes a low-rate mono PCM stream for the waveform — so the audio is only
 * decoded once.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ */
/*  Binary resolution                                                  */
/* ------------------------------------------------------------------ */

// ffmpeg-static / ffprobe-static point at a binary inside the app tree. In a
// packaged Electron build that path lives inside app.asar (not executable), so
// the installer unpacks it to app.asar.unpacked — rewrite the path to match.
function unpacked(p) {
  return p && p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

function fromStatic(mod, pick) {
  try {
    const resolved = pick(require(mod));
    if (resolved && fs.existsSync(unpacked(resolved))) return unpacked(resolved);
  } catch { /* optional dependency not installed */ }
  return null;
}

// Resolve the ffmpeg binary. Priority: explicit user override → bundled static
// → bare 'ffmpeg' on PATH (last-ditch, may not exist).
function resolveFfmpeg(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  return fromStatic('ffmpeg-static', (m) => (typeof m === 'string' ? m : m && m.path)) || 'ffmpeg';
}

function resolveFfprobe(customPath) {
  // A custom ffmpeg path usually sits next to an ffprobe of the same build.
  if (customPath && fs.existsSync(customPath)) {
    const sibling = path.join(path.dirname(customPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) return sibling;
  }
  return fromStatic('ffprobe-static', (m) => m && m.path) || 'ffprobe';
}

/* ------------------------------------------------------------------ */
/*  Low-level process runner                                           */
/* ------------------------------------------------------------------ */

class FfmpegError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    this.stderr = stderr;
  }
}

// Keep only the tail of stderr for error reporting — ffmpeg is chatty.
function tail(str, lines = 12) {
  return str.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

/*
 * Spawn a binary and stream its output.
 *   onStdout(buf)      — raw stdout chunks (used to collect PCM)
 *   onStderrLine(line) — stderr split on \n AND \r (ffmpeg rewrites progress with \r)
 *   signal             — AbortSignal; aborting kills the child and rejects with 'Canceled'
 */
function run(bin, args, { onStdout, onStderrLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      reject(new FfmpegError(`Could not start ${path.basename(bin)}: ${err.message}`));
      return;
    }

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const stderrChunks = [];
    let stderrRemainder = '';

    if (onStdout) child.stdout.on('data', onStdout);
    else child.stdout.on('data', () => {});

    child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderrChunks.push(text);
      if (onStderrLine) {
        const combined = stderrRemainder + text;
        const parts = combined.split(/\r|\n/);
        stderrRemainder = parts.pop() ?? '';
        for (const line of parts) if (line) onStderrLine(line);
      }
    });

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`${path.basename(bin)} failed to run: ${err.message}`));
    });

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (onStderrLine && stderrRemainder) onStderrLine(stderrRemainder);
      const stderr = stderrChunks.join('');
      if (aborted) {
        reject(new FfmpegError('Canceled', { code, stderr }));
      } else if (code === 0) {
        resolve({ stderr });
      } else {
        reject(new FfmpegError(tail(stderr) || `${path.basename(bin)} exited with code ${code}`, { code, stderr }));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Time / parsing helpers                                             */
/* ------------------------------------------------------------------ */

// ffmpeg progress lines carry `time=00:01:23.45` (or `time=N/A` before it starts).
const TIME_RE = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
function parseTime(line) {
  const m = TIME_RE.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const SIL_START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const SIL_END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/* ------------------------------------------------------------------ */
/*  probe                                                              */
/* ------------------------------------------------------------------ */

async function probe(input, { ffprobePath } = {}) {
  const bin = resolveFfprobe(ffprobePath);
  let out = '';
  await run(bin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input,
  ], { onStdout: (buf) => { out += buf.toString('utf8'); } });

  let info;
  try {
    info = JSON.parse(out);
  } catch (err) {
    throw new FfmpegError(`Could not read media info: ${err.message}`);
  }

  const streams = Array.isArray(info.streams) ? info.streams : [];
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const videoStreams = streams.filter((s) => s.codec_type === 'video');

  // Duration can live on the format or on individual streams depending on
  // container. Take the largest finite value we can find.
  const candidates = [info.format && info.format.duration, ...streams.map((s) => s.duration)]
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d > 0);
  const duration = candidates.length ? Math.max(...candidates) : 0;

  return {
    duration,
    hasAudio: audioStreams.length > 0,
    hasVideo: videoStreams.length > 0,
    audioStreams,
    videoStreams,
    format: info.format || null,
  };
}

/* ------------------------------------------------------------------ */
/*  analyze — silence detection + waveform in one pass                 */
/* ------------------------------------------------------------------ */

const WAVE_TARGET_SAMPLES = 3_000_000; // caps memory / stdout size for long files
const WAVE_MIN_RATE = 200;
const WAVE_MAX_RATE = 2000;
const PEAK_BUCKETS = 1600; // waveform bars drawn on the timeline

function waveformRate(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 1000;
  return Math.round(clamp(WAVE_TARGET_SAMPLES / duration, WAVE_MIN_RATE, WAVE_MAX_RATE));
}

// Reduce an Int16 mono PCM buffer to `buckets` peak values, then normalize for
// display: the loudest bucket becomes 1.0 so the waveform fills the timeline
// regardless of absolute recording level (silence stays ~0). A gentle gamma
// lifts mid-level speech so it reads clearly. Detection is unaffected — this is
// purely the visual envelope; silence is decided by silencedetect's dB test.
function peaksFromPcm(buf, buckets) {
  const samples = Math.floor(buf.length / 2);
  const raw = new Array(buckets).fill(0);
  if (samples === 0) return raw;

  const per = samples / buckets;
  let loudest = 0;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    // When the clip is shorter than `buckets` samples (per < 1), floor(b*per)
    // and floor((b+1)*per) collide for many buckets — leaving them empty and
    // combing the waveform. Guarantee every bucket samples at least one point.
    let end = Math.floor((b + 1) * per);
    if (end <= start) end = start + 1;
    end = Math.min(samples, end);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    raw[b] = max / 32768;
    if (max / 32768 > loudest) loudest = max / 32768;
  }

  const gamma = 0.8;
  return raw.map((p) => {
    const norm = loudest > 0 ? p / loudest : 0;
    return Number(Math.pow(norm, gamma).toFixed(4));
  });
}

// Pair up silence_start / silence_end markers into [{start,end}] spans, clamped
// to the media duration. A trailing silence with no end (runs to EOF) is closed
// at `duration`.
function pairSilences(marks, duration) {
  const segments = [];
  let openStart = null;
  for (const m of marks) {
    if (m.type === 'start') {
      openStart = Math.max(0, m.t);
    } else if (m.type === 'end' && openStart !== null) {
      const end = duration > 0 ? Math.min(duration, m.t) : m.t;
      if (end > openStart) segments.push({ start: openStart, end });
      openStart = null;
    }
  }
  if (openStart !== null && duration > 0 && duration > openStart) {
    segments.push({ start: openStart, end: duration });
  }
  return segments;
}

/**
 * Detect dead air and build a waveform.
 * @param opts { thresholdDb, minSilenceSec, ffmpegPath, ffprobePath }
 * @param onProgress (ratio 0..1) — best-effort, based on decoded time
 * @param signal AbortSignal
 */
async function analyze(input, opts = {}, onProgress, signal) {
  const thresholdDb = Number.isFinite(opts.thresholdDb) ? opts.thresholdDb : -30;
  const minSilenceSec = Number.isFinite(opts.minSilenceSec) ? opts.minSilenceSec : 1.5;

  const meta = await probe(input, { ffprobePath: opts.ffprobePath });
  const duration = meta.duration;

  // No audio track → nothing to detect. Return a flat, honest result.
  if (!meta.hasAudio) {
    return {
      input,
      duration,
      hasAudio: false,
      thresholdDb,
      minSilenceSec,
      sampleRate: 0,
      segments: [],
      peaks: new Array(PEAK_BUCKETS).fill(0),
      generatedAt: new Date().toISOString(),
    };
  }

  const rate = waveformRate(duration);
  const bin = resolveFfmpeg(opts.ffmpegPath);

  const args = [
    '-hide_banner',
    '-nostdin',
    '-i', input,
    '-map', '0:a:0',
    '-vn', '-sn', '-dn',
    // silencedetect analyzes the audio at native rate; output is resampled for the waveform.
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
    '-ac', '1',
    '-ar', String(rate),
    '-f', 's16le',
    'pipe:1',
  ];

  const pcmChunks = [];
  const marks = [];
  let lastRatio = 0;

  await run(bin, args, {
    signal,
    onStdout: (buf) => pcmChunks.push(buf),
    onStderrLine: (line) => {
      const sStart = SIL_START_RE.exec(line);
      if (sStart) marks.push({ type: 'start', t: Number(sStart[1]) });
      const sEnd = SIL_END_RE.exec(line);
      if (sEnd) marks.push({ type: 'end', t: Number(sEnd[1]) });

      if (onProgress && duration > 0) {
        const t = parseTime(line);
        if (t !== null) {
          const ratio = clamp(t / duration, 0, 1);
          if (ratio - lastRatio >= 0.005 || ratio >= 1) {
            lastRatio = ratio;
            onProgress(ratio);
          }
        }
      }
    },
  });

  if (onProgress) onProgress(1);

  const pcm = Buffer.concat(pcmChunks);
  const peaks = peaksFromPcm(pcm, PEAK_BUCKETS);

  // If probe couldn't determine duration, recover it from the decoded sample count.
  const effectiveDuration = duration > 0 ? duration : Math.floor(pcm.length / 2) / rate;

  const rawSegments = pairSilences(marks, effectiveDuration);
  const segments = rawSegments.map((s, i) => ({
    id: i,
    start: Number(s.start.toFixed(3)),
    end: Number(s.end.toFixed(3)),
    cut: true,
  }));

  return {
    input,
    duration: Number(effectiveDuration.toFixed(3)),
    hasAudio: true,
    thresholdDb,
    minSilenceSec,
    sampleRate: rate,
    segments,
    peaks,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  renderCut — trim to the kept ranges and re-encode                  */
/* ------------------------------------------------------------------ */

// Merge overlapping/adjacent ranges and drop empties. Defensive: the renderer
// already sends clean ranges, but we never want a malformed filter graph.
function normalizeRanges(ranges, duration) {
  const clean = (ranges || [])
    .map((r) => ({ start: Math.max(0, Number(r.start)), end: Number(r.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => (duration > 0 ? { start: Math.min(r.start, duration), end: Math.min(r.end, duration) } : r))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-3) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

function buildFilterScript(keep, hasAudio) {
  const lines = [];
  const labels = [];
  keep.forEach((r, i) => {
    const s = r.start.toFixed(3);
    const e = r.end.toFixed(3);
    lines.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}];`);
    if (hasAudio) lines.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}];`);
    labels.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  const n = keep.length;
  if (hasAudio) {
    lines.push(`${labels.join('')}concat=n=${n}:v=1:a=1[outv][outa]`);
  } else {
    lines.push(`${labels.join('')}concat=n=${n}:v=1:a=0[outv]`);
  }
  return lines.join('\n');
}

/**
 * Render `input` down to only the `keep` ranges, concatenated, re-encoded.
 * Frame-accurate (uses trim/atrim + concat filters).
 *
 * @param keep  [{start,end}] ranges to KEEP (seconds), in source time
 * @param out   destination path (extension implies container)
 * @param opts  { hasAudio, duration, ffmpegPath, crf, preset }
 * @param onProgress (ratio 0..1) — based on output time vs total kept duration
 * @param signal AbortSignal
 */
async function renderCut(input, keep, out, opts = {}, onProgress, signal) {
  const duration = Number(opts.duration) || 0;
  const ranges = normalizeRanges(keep, duration);
  if (ranges.length === 0) {
    throw new FfmpegError('Nothing left to keep — every segment is marked as a cut.');
  }

  const hasAudio = opts.hasAudio !== false;
  const totalKept = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);

  // The filter graph can be large (one trim per kept range); pass it via a
  // script file so we never hit command-line length limits. Each render gets a
  // private temp dir so overlapping/rapid renders can't clobber each other's
  // script (the process PID is constant for the app's whole lifetime).
  const script = buildFilterScript(ranges, hasAudio);
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-cutter-'));
  const scriptPath = path.join(scriptDir, 'filter.txt');
  fs.writeFileSync(scriptPath, script, 'utf8');

  const ext = path.extname(out).slice(1).toLowerCase();
  const crf = Number.isFinite(opts.crf) ? opts.crf : 20;
  const preset = opts.preset || 'veryfast';

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-filter_complex_script', scriptPath,
    '-map', '[outv]',
    ...(hasAudio ? ['-map', '[outa]'] : []),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    ...(ext === 'mp4' || ext === 'mov' ? ['-movflags', '+faststart'] : []),
    out,
  ];

  const bin = resolveFfmpeg(opts.ffmpegPath);
  let lastRatio = 0;

  try {
    await run(bin, args, {
      signal,
      onStderrLine: (line) => {
        if (!onProgress || totalKept <= 0) return;
        const t = parseTime(line);
        if (t !== null) {
          const ratio = clamp(t / totalKept, 0, 1);
          if (ratio - lastRatio >= 0.005 || ratio >= 1) {
            lastRatio = ratio;
            onProgress(ratio);
          }
        }
      },
    });
  } finally {
    try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (onProgress) onProgress(1);
  return { path: out, keptRanges: ranges.length, keptDuration: Number(totalKept.toFixed(3)) };
}

module.exports = {
  FfmpegError,
  resolveFfmpeg,
  resolveFfprobe,
  probe,
  analyze,
  renderCut,
  // exported for tests
  _internal: { peaksFromPcm, pairSilences, normalizeRanges, buildFilterScript, waveformRate, parseTime },
};
