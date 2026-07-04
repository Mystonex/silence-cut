/*
 * Cut planning — the single source of truth for turning detected silence
 * segments + detection settings into concrete removed / kept regions.
 *
 * UMD-guarded so it loads both as a plain <script> in the renderer (exposing
 * `window.CutPlan`) and via require() in a headless Node test — the same math
 * powers the on-screen preview, the exported cut list, and the rendered video.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CutPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // Merge overlapping / touching ranges into a minimal sorted set.
  function mergeRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r.start <= last.end + 1e-3) last.end = Math.max(last.end, r.end);
      else out.push({ start: r.start, end: r.end });
    }
    return out;
  }

  // Gaps between `ranges` within [0, dur] — what's left after the removals.
  function complement(ranges, dur) {
    const keep = [];
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) keep.push({ start: cursor, end: Math.min(r.start, dur) });
      cursor = Math.max(cursor, r.end);
    }
    if (cursor < dur) keep.push({ start: cursor, end: dur });
    return keep.filter((k) => k.end - k.start > 1e-3);
  }

  /**
   * @param cutSegs  [{start,end}] silence spans the user has marked to cut
   * @param det      detection settings { leadInSec, leadOutSec, minKeepSec }
   * @param dur      media duration (seconds)
   * @returns { removed, keep, removedTotal, keepTotal, dur }
   */
  function planCuts(cutSegs, det, dur) {
    const leadIn = Number(det.leadInSec) || 0;
    const leadOut = Number(det.leadOutSec) || 0;
    const minKeep = Number(det.minKeepSec) || 0;

    // Shrink each silence by the padding kept around speech, then clamp + merge.
    let removed = cutSegs
      .map((s) => ({ start: s.start + leadOut, end: s.end - leadIn }))
      .filter((r) => r.end - r.start > 1e-3)
      .map((r) => ({ start: clamp(r.start, 0, dur), end: clamp(r.end, 0, dur) }))
      .filter((r) => r.end - r.start > 1e-3);
    removed = mergeRanges(removed);

    let keep = complement(removed, dur);

    // A kept clip shorter than minKeep isn't worth keeping — drop it, which
    // merges its neighbouring cuts. Only recompute removals if we dropped one.
    if (minKeep > 0) {
      const filtered = keep.filter((k) => (k.end - k.start) >= minKeep);
      if (filtered.length !== keep.length) {
        keep = filtered;
        removed = complement(keep, dur);
      }
    }

    const removedTotal = removed.reduce((s, r) => s + (r.end - r.start), 0);
    const keepTotal = keep.reduce((s, r) => s + (r.end - r.start), 0);
    return { removed, keep, removedTotal, keepTotal, dur };
  }

  return { clamp, mergeRanges, complement, planCuts };
});
