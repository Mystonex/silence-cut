# Settings — the `.dom` files

Silence Cutter stores its configuration as **`.dom`** files.

> **Why `.dom`?** It's made by **Dom**schii. 😎 On the inside it's plain JSON —
> open, diff, and hand-edit it in any text editor — it just wears the creator's
> name as its extension. (Works as a backronym too: *Dead-air Options Manifest*.)

| File                 | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `default.dom`        | Factory defaults. **Reset to defaults** copies this over the active file. |
| `silence-cutter.dom` | The **active** config the app reads/writes. This is your working copy.  |

Exporting settings from the app writes a `.dom` you can share or back up.
Importing merges a `.dom` on top of the defaults and saves it as the active config.

## Fields

### `detection`
| Key             | Unit  | Meaning                                                                    |
| --------------- | ----- | -------------------------------------------------------------------------- |
| `thresholdDb`   | dBFS  | Audio at/below this loudness counts as silence. `-30` is a good start. Lower (e.g. `-40`) = only very quiet moments count. |
| `minSilenceSec` | sec   | A quiet stretch must last at least this long to be treated as dead air.    |
| `leadInSec`     | sec   | Keep this much silence **before speech resumes** (breathing room in).      |
| `leadOutSec`    | sec   | Keep this much silence **after speech ends** (breathing room out).         |
| `minKeepSec`    | sec   | Don't produce kept clips shorter than this between two cuts.               |

### `output`
| Key             | Values                     | Meaning                                            |
| --------------- | -------------------------- | -------------------------------------------------- |
| `mode`          | `video` `cutlist` `both`   | Produce a trimmed video, an EDL/cut list, or both. |
| `format`        | `mp4` `mkv` `mov`          | Container for the rendered trimmed video.          |
| `suffix`        | string                     | Appended to the output filename.                   |
| `cutlistFormat` | `json` `edl`               | How the cut list is serialized.                    |

### `app`
| Key          | Values                | Meaning                                             |
| ------------ | --------------------- | --------------------------------------------------- |
| `theme`      | `dark` `light` `auto` | UI theme.                                           |
| `accent`     | hex color             | Accent/glow color of the interface.                 |
| `ffmpegPath` | path or `""`          | Custom ffmpeg binary. Empty = use the bundled one.  |
