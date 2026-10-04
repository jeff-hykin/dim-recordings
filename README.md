# dim-recordings

A [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop) app for the robot recordings in Desktop's recordings
folder: memory2 `.db` files, `.mcap` files, and the Rerun `.rrd` files made from them.

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-recordings
```

## What it does

- **List**: name, size, duration, when it was recorded (its first message's time, else the file's), and a stream summary
  ("2 cameras · point cloud · odometry · tf"). It sorts by date, size or duration, either way. Sorted by date, the list
  falls into Today / Yesterday / This week / Last week / This month sections, then one per month.
- **Previews**: a background job picks each recording's main camera (color before grayscale before depth, then the most
  pixels) and keeps 15 frames from its start, middle and end. A row plays its preview while it's on screen, and the
  pointer's x scrubs it. The job is slow on purpose: one recording at a time, ffmpeg under `nice -n 19`, a pause between
  frames. Works for `.db` and `.mcap` (LCM or CDR `Image` / `CompressedImage`).
- **Summary** (hover): every stream's type, encoding, count, rate, p99 and largest gap, and the tf frame tree, like
  `dtk data summary`. It also holds a note, kept in the app's data dir (`DIMOS_APP_DATA`), never in the file.
- **Open**: in the Replayer (`#/replay/<id>`, this app), the Map Editor (when `dim-map-builder` is installed), or
  Foxglove (when installed, and only for an `.mcap` whose image, point cloud and camera_info channels are CDR). An
  `.rrd` lists under the `.db` / `.mcap` with its name. It opens in the Rerun app (`dim-rerun`), else the `rerun`
  viewer, else the button says what's missing.
- **Actions**: rename, delete (asks first), duplicate, convert to `.db` / `.mcap` / `.rrd` (with
  [dtk](https://github.com/jeff-hykin/dtk), with progress), copy path, show in folder, and upload to the Dimensional
  cloud through Desktop's `/dimos/uploads` (a tray with progress and ETA; once a file is uploaded, its button becomes a
  link).

Each of these is an HTTP endpoint (`backend/recordings/routes.ts`, listed in dimos.yaml's `agent:`), so Desktop's agent
can do anything the page does.

## Layout

| path                              | what                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/recordings/`             | scan + rrd pairing, inspection (`dtk data summary`'s logic), sorting and date sections, actions, conversion jobs, previews, open targets, uploads |
| `backend/replay/`                 | the Replayer's routes (empty so far)                                                                                                              |
| `frontend/src/views/`             | `Library.tsx` (the list), `SummaryPanel.tsx`, `Uploads.tsx`, `Replay.tsx` (the `#/replay/<id>` slot)                                              |
| `frontend/src/dim-app/`           | the dim-app theme (Portal dark / Research light), vendored at the tag in `VERSION`                                                                |
| `scripts/make_test_recordings.ts` | short clips with shifted times (for the date sections) and a raw-LCM `.mcap` (which Foxglove can't draw)                                          |

## Development

```sh
deno task test && deno task check     # backend tests (tiny .db/.mcap files made on the fly), dimos.yaml ↔ routes check
cd frontend && npm install && npm run build
deno run -A backend/main.ts --port 8787 --recordings-dir <dir> --data-dir <dir> [--desktop-url http://127.0.0.1:7341]
nix build .#dimosApp                  # what Desktop builds: bin/dimos-app-server
```

Converting needs `dtk` on PATH (or `DIM_RECORDINGS_DTK="deno run -A <checkout>/main.js"`); previews need ffmpeg (the nix
build brings it).

Licensed under Apache-2.0.
