<div align="center">

# 🎬 Silence Cut

### Automatic dead-air cutter for streams & long recordings

*Point it at a video. It finds the silence. You keep the good parts.*

<sub>a tool by **Domschii**</sub>

<br>

![version](https://img.shields.io/badge/version-0.1.0-6ee7ff?style=for-the-badge)
![status](https://img.shields.io/badge/status-UI_shell-a78bfa?style=for-the-badge)
![electron](https://img.shields.io/badge/Electron-32-47848F?style=for-the-badge&logo=electron&logoColor=white)
![node](https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-ffffff?style=for-the-badge)

</div>

---

## ✨ The idea

You stream. You record long takes. And between the good moments there are those
awkward stretches where you're reading chat, thinking, or just *not talking*.

**Silence Cut** scans a video's audio, finds every quiet stretch below a loudness
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
> **This is `v0.1` — the UI shell.** The interface, menus, live timeline
> preview, and `.dom` settings are fully wired. Detection currently runs on a
> **mock** analysis engine so you can see and feel the entire flow end-to-end.
> The real ffmpeg `silencedetect` pipeline and video rendering land in **v0.2** —
> the plumbing is already in place.

---

## 🚀 Quick start

```bash
npm install     # pulls Electron
npm start        # launch the app
```

| Command | What it does |
| ------- | ------------ |
| `npm start` | Launch Silence Cut |
| `npm run dev` | Launch with DevTools attached |
| `npm run check` | Syntax-check all source files |

**Requirements:** Node **18+** and npm. `ffmpeg` / `ffprobe` are declared as
*optional* dependencies, so v0.1 installs cleanly even if the binaries fail to
download — they aren't used until v0.2.

---

## 🎛️ What works today

| | Feature |
| :--: | ------- |
| 🪟 | **Glassy Electron UI** — macOS window vibrancy, a custom draggable title bar, and an in-window action row |
| 📂 | **Native menu bar** — File / Edit / View / Window / Help, with full keyboard shortcuts |
| ⤵️ | **Import** three ways — title-bar button, **File → Import Video** (`⌘O`), or **drag & drop** onto the window |
| 🌊 | **Waveform timeline** — `Analyze` (`⌘R`) draws detected dead-air segments right on the wave |
| ✋ | **Review & approve** — click any red block (or its list row) to *keep* that moment instead of cutting it |
| 📊 | **Live stats** — see time removed and final runtime update as you go |
| 🎚️ | **Settings drawer** — every slider updates the timeline preview live as you drag |
| 💾 | **Export cut list** — writes a real, non-destructive JSON EDL of the regions to remove |
| 🗂️ | **Portable settings** — import / export / reset config as `.dom` files |

> **Export trimmed video** is intentionally stubbed with a friendly *"coming in
> v0.2"* — the button and pipeline are wired, the renderer just isn't hooked up yet.

---

## 🧩 Settings — the `.dom` file

Config lives in [`settings/`](settings/) as **`.dom`** files.

> **Why `.dom`?** Because it's made by **Dom**schii. 😎 It's plain JSON on the
> inside — open, diff, and hand-edit it in any text editor — it just wears the
> creator's name as its extension.

| File | Purpose |
| ---- | ------- |
| [`default.dom`](settings/default.dom) | Factory defaults. *Reset to defaults* copies this over the active file. |
| [`hushcut.dom`](settings/hushcut.dom) | The **active** config the app reads/writes — your working copy. |

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
    "format":       "mp4",  // mp4 · mkv · mov  (render in v0.2)
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
│  ├─ hushcut.dom        # active config (read/written by the app)
│  └─ README.md          # field reference
└─ src/
   ├─ main/
   │  ├─ main.js         # window, native menu, IPC, mock analysis engine
   │  ├─ preload.js      # contextBridge — the only renderer ↔ main surface
   │  └─ settings.js     # .dom load / save / merge / validate
   └─ renderer/
      ├─ index.html      # UI structure
      ├─ styles.css      # glassmorphism theme
      └─ renderer.js     # timeline, drawer, drag-drop, export
```

---

## 🔒 Security posture

`contextIsolation` **on**, `nodeIntegration` **off**, `sandbox` **on**, a strict
CSP, and a narrow context-bridge — the renderer never touches Node directly.

---

## 🛣️ Roadmap

- [x] **v0.1** — glassy UI shell, native menus, live timeline, `.dom` settings, mock detection
- [ ] **v0.2** — real ffmpeg `silencedetect` analysis + actual trimmed-video render
- [ ] Waveform generated from real audio
- [ ] Per-segment nudge handles
- [ ] Batch / folder processing

---

<div align="center">

Made by **Domschii** — for streamers who talk a lot, and sometimes don't.

**MIT Licensed** · Built with Electron

</div>
