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
   * Turn raw detected silence spans into concrete cut regions by baking in the
   * lead-in / lead-out padding (breathing room kept around speech). Done once at
   * Analyze time so the blocks the user then drags ARE the exact removed regions
   * — dragging an edge moves the cut 1:1 with no hidden offset.
   * @param silences [{start,end}] raw silence spans from detection
   * @param det      { leadInSec, leadOutSec }
   * @param dur      media duration (seconds)
   * @returns [{start,end}] cut regions (empties dropped)
   */
  function deriveCuts(silences, det, dur) {
    const leadIn = Number(det.leadInSec) || 0;
    const leadOut = Number(det.leadOutSec) || 0;
    return (silences || [])
      .map((s) => ({ start: clamp(s.start + leadOut, 0, dur), end: clamp(s.end - leadIn, 0, dur) }))
      .filter((r) => r.end - r.start > 1e-3);
  }

  /**
   * Plan removed / kept regions from already-concrete cut regions (no padding —
   * padding is already baked in by deriveCuts or drawn by hand). Merges
   * overlaps, computes the kept complement, and drops kept slivers below
   * minKeepSec (which merges their neighbouring cuts).
   * @param cuts       [{start,end}] concrete cut regions to remove
   * @param minKeepSec smallest kept clip worth keeping
   * @param dur        media duration (seconds)
   * @returns { removed, keep, removedTotal, keepTotal, dur }
   */
  function planFromCuts(cuts, minKeepSec, dur) {
    const minKeep = Number(minKeepSec) || 0;
    let removed = mergeRanges(
      (cuts || [])
        .map((c) => ({ start: clamp(c.start, 0, dur), end: clamp(c.end, 0, dur) }))
        .filter((r) => r.end - r.start > 1e-3)
    );

    let keep = complement(removed, dur);

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

  /**
   * Convenience: derive cuts from raw silences (with padding) and plan in one
   * step. Kept for callers/tests that go straight from detection to a plan.
   * @param silences [{start,end}] raw silence spans
   * @param det      { leadInSec, leadOutSec, minKeepSec }
   * @param dur      media duration
   */
  function planCuts(silences, det, dur) {
    return planFromCuts(deriveCuts(silences, det, dur), det && det.minKeepSec, dur);
  }

  return { clamp, mergeRanges, complement, deriveCuts, planFromCuts, planCuts };
});
