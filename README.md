<div align="center">

# 🎬 Silence Cutter

### Automatic dead-air cutter for streams & long recordings

*Point it at a video. It finds the silence. You keep the good parts.*

<sub>a tool by **Domschii**</sub>

<br>

![version](https://img.shields.io/badge/version-0.1.0-6ee7ff?style=for-the-badge)
![status](https://img.shields.io/badge/status-working-59e6a3?style=for-the-badge)
![electron](https://img.shields.io/badge/Electron-32-47848F?style=for-the-badge&logo=electron&logoColor=white)
![node](https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-ffffff?style=for-the-badge)

</div>

---

## ✨ The idea

You stream. You record long takes. And between the good moments there are those
awkward stretches where you're reading chat, thinking, or just *not talking*.

**Silence Cutter** scans a video's audio, finds every quiet stretch below a loudness
threshold you set (in **dB**), and lines up clean cuts — trimming the silence
while leaving a little breathing room before and after. You review each cut on a
waveform timeline, veto the ones you want to keep, then export a trimmed video
and/or a non-destructive cut list.

<div align="center">

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  IMPORT  │ ──▶ │ ANALYZE  │ ──▶ │  REVIEW  │ ──▶ │  EXPORT  │
  │  video   │     │  dB scan │     │ timeline │     │ cut/edit │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
     ⌘O               ⌘R             keep / cut        cut list ✓
```

</div>

> [!NOTE]
> **`v0.1` — end-to-end working.** Import a video, run **real** ffmpeg
> `silencedetect` analysis over the actual audio, review the detected dead air on
> a real waveform, then export a non-destructive cut list **and/or** a rendered,
> frame-accurate trimmed video. ffmpeg / ffprobe ship bundled — no separate
> install needed.

---

## 🚀 Quick start

```bash
npm install     # pulls Electron
npm start        # launch the app
```

| Command | What it does |
| ------- | ------------ |
| `npm start` | Launch Silence Cutter |
| `npm run dev` | Launch with DevTools attached |
| `npm run check` | Syntax-check all source files |

**Requirements:** Node **18+** and npm. `ffmpeg-static` / `ffprobe-static` are
pulled in on install and power analysis + rendering out of the box. Prefer your
own build? Point **Settings → Engine → Custom ffmpeg path** at it.

---

## 🎛️ What works today

| | Feature |
| :--: | ------- |
| 🪟 | **Glassy Electron UI** — macOS window vibrancy, a custom draggable title bar, and an in-window action row |
| 📂 | **Native menu bar** — File / Edit / View / Window / Help, with full keyboard shortcuts |
| ⤵️ | **Import** three ways — title-bar button, **File → Import Video** (`⌘O`), or **drag & drop** onto the window |
| 🔍 | **Real dead-air detection** — `Analyze` (`⌘R`) runs ffmpeg `silencedetect` over the actual audio at your dB threshold |
| 🌊 | **dBFS waveform + dB scale** — the wave is drawn against a real `−60…0 dB` axis, with a live **threshold line** so you can *see* which audio counts as silence and tune the threshold by eye |
| 🎞️ | **Linked frame preview** — hover or scrub the timeline and a floating video-frame preview shows exactly where you are (with a timestamp) |
| ✂️ | **Hand-editable cuts** — drag a cut's **edges to trim**, its **body to move**, **double-click** empty space to add one, and **⌫** or the ✕ to delete; what you see on the wave is exactly what gets removed |
| ✋ | **Keep / cut toggle** — flip any detected block to *keep* without deleting it |
| 📊 | **Live stats** — time removed and final runtime update as you drag cuts or the sliders |
| 🎬 | **Export trimmed video** — frame-accurate re-encode (trim + concat) with a live progress bar you can cancel |
| 💾 | **Export cut list** — a non-destructive JSON EDL of the exact regions removed |
| 🗂️ | **Portable settings** — import / export / reset config as `.dom` files |

---

## 🧩 Settings — the `.dom` file

Config lives in [`settings/`](settings/) as **`.dom`** files.

> **Why `.dom`?** Because it's made by **Dom**schii. 😎 It's plain JSON on the
> inside — open, diff, and hand-edit it in any text editor — it just wears the
> creator's name as its extension.

| File | Purpose |
| ---- | ------- |
| [`default.dom`](settings/default.dom) | Factory defaults. *Reset to defaults* copies this over the active file. |
| [`silence-cutter.dom`](settings/silence-cutter.dom) | The **active** config the app reads/writes — your working copy. |

The setting to start with is **`detection.thresholdDb`** (default `-30`): audio
quieter than this counts as dead air. Lower it (e.g. `-40`) to catch only the
truly silent moments.

```jsonc
{
  "detection": {
    "thresholdDb":   -30,   // dBFS — quieter than this = silence
    "minSilenceSec":  1.5,  // a gap must last this long to count
    "leadInSec":      0.4,  // breathing room kept before speech resumes
    "leadOutSec":     0.4,  // breathing room kept after speech ends
    "minKeepSec":     0.5   // don't emit kept clips shorter than this
  },
  "output": {
    "mode":         "both", // video · cutlist · both
    "format":       "mp4",  // mp4 · mkv · mov  (container for the render)
    "suffix":       "_silencecut",
    "cutlistFormat":"json"  // json · edl
  },
  "app": {
    "theme":     "dark",    // dark · light · auto
    "accent":    "#6ee7ff", // interface glow color
    "ffmpegPath": ""        // custom binary, or "" for the bundled one
  }
}
```

📖 Full field-by-field reference: [`settings/README.md`](settings/README.md).

---

## 🗂️ Project layout

```
video-cutting/
├─ package.json
├─ settings/
│  ├─ default.dom        # factory defaults
│  ├─ silence-cutter.dom # active config (read/written by the app)
│  └─ README.md          # field reference
└─ src/
   ├─ main/
   │  ├─ main.js         # window, native menu, IPC, job orchestration
   │  ├─ ffmpeg.js       # engine: probe, silencedetect + waveform, render
   │  ├─ preload.js      # contextBridge — the only renderer ↔ main surface
   │  └─ settings.js     # .dom load / save / merge / validate
   └─ renderer/
      ├─ index.html      # UI structure
      ├─ styles.css      # glassmorphism theme
      ├─ cutplan.js      # shared cut planner (padding · min-keep · complement)
      └─ renderer.js     # timeline, drawer, drag-drop, progress, export
```

---

## 🔒 Security posture

`contextIsolation` **on**, `nodeIntegration` **off**, `sandbox` **on**, a strict
CSP, and a narrow context-bridge — the renderer never touches Node directly.

---

## 🛣️ Roadmap

- [x] **v0.1** — glassy UI shell, native menus, `.dom` settings, live timeline
- [x] Real ffmpeg `silencedetect` analysis + real waveform from decoded audio
- [x] Frame-accurate trimmed-video render with cancelable progress
- [x] dBFS waveform with dB scale + live threshold line
- [x] Linked video-frame preview on hover/scrub
- [x] Draggable, hand-editable cut regions (resize · move · add · delete)
- [ ] Keyframe-based fast (stream-copy) cutting mode
- [ ] Playback of the trimmed result in-app
- [ ] Batch / folder processing

---

<div align="center">

Made by **Domschii** — for streamers who talk a lot, and sometimes don't.

**MIT Licensed** · Built with Electron

</div>
