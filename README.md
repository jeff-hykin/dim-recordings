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
- **Summary**: click a row (desktop) to select it and show its summary in a side panel (↑ / ↓ move the selection, Esc
  closes); on a phone a row's Summary button opens it as a sheet. Every stream's type, encoding, count, rate, p99 and
  largest gap, colored the way `dtk data summary --html` does (p99 / gap vs the average interval: even < 2.7×, uneven,
  gappy ≥ 7.4×, as the theme's status colors; count / hz as a log bar), and the tf frame tree. It also holds a note,
  kept in the app's data dir (`DIMOS_APP`'s `dataDir`), never in the file.
- **Open**: in the Replayer (`#/replay/<id>`, this app), the Map Editor (when `dim-map-builder` is installed), or
  Foxglove (when installed, and only for an `.mcap` whose image, point cloud and camera_info channels are CDR). An
  `.rrd` lists under the `.db` / `.mcap` with its name. It opens in the Rerun app (`dim-rerun`), else the `rerun`
  viewer, else the button says what's missing.
- **Actions**: Upload, Rename and (set apart) Delete (asks first) on the row; in its ⋯ menu: duplicate, convert to `.db`
  / `.mcap` / `.rrd` (with [dtk](https://github.com/jeff-hykin/dtk), with progress), copy path, show in folder, and
  upload to the Dimensional cloud through Desktop's `/dimos/uploads` (a tray with progress and ETA; once a file is
  uploaded, its button becomes a link).

- **Replayer** (`#/replay/<id>`): the Controller's live view (dim-controller's frontend: 3D with point clouds, poses and
  the odometry route, camera panels, the tf tree, layers) playing the recording, with no drive / WASD / arm controls. A
  timeline docked at the bottom plays, pauses, changes speed and scrubs; expanded, it has a row per stream with a tick
  per message (scroll to zoom), a switch to draw or hide it, and rename / duplicate / delete, which edit the `.db` or
  `.mcap` in place. Nothing is loaded up front: the backend reads a stream's message times when it's first needed and a
  message when the playhead reaches it. While scrubbing, cameras show 192-px thumbnails (made in the background for
  jpeg/png streams, thinned on the fly for raw ones) and clouds are thinned to 6k points; playing or paused, everything
  is full resolution.

Each of these is an HTTP endpoint (`backend/recordings/routes.ts`, `backend/replay/routes.ts`, listed in dimos.yaml's
`agent:`), so Desktop's agent can do anything the page does.

## Backend → page

Desktop's rule (its docs/events.md): the page asks over HTTP and hears back over zenoh, on its one zenoh-web connection
(dim-app's `getZenoh()`). The backend publishes through Desktop's relay (`POST /desktop/frontend/<name>/<topic>`,
dim-app's `frontend_publish.js`, vendored in `backend/dim-app/`):

- `state/recordings` — `stateChanged("recordings")` on a rename, delete, duplicate, note, inspection, preview, finished
  conversion or a change in the folder; the list (`useBackendState`) re-GETs `api/recordings`.
- `state/uploads` — after an upload action; the tray also re-GETs `api/uploads` on the dimos server's upload events
  (`<ns>/dimos/events/upload`, `uploads`, `upload-removed`, `cloud-login`).
- `events` — `{type: "job", job}` (conversion progress), `{type: "thumbnail", id}`, and `{type: "replay", action, id}`
  (`POST api/replay/{id}/control`, the agent driving open Replayers).

**The exception**: the Replayer's playback stream, `api/replay/{id}/ws`, stays a websocket (Jeff's call, 2026-10-05): it
is the page's internal request/answer stream for frames at the playhead (subscribe, seek / play / scrub, and the frames
back, with drop-to-latest and thumbnail-while-scrubbing), not an event feed.

## Layout

| path                              | what                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/recordings/`             | scan + rrd pairing, inspection (`dtk data summary`'s logic), sorting and date sections, actions, conversion jobs, previews, open targets, uploads                   |
| `backend/replay/`                 | the Replayer: lazy sources over a .db / .mcap (`source.ts`), the playback websocket (`player.ts`), thumbnails, in-place stream edits (`edit_db.ts`, `edit_mcap.ts`) |
| `frontend/src/views/`             | `Library.tsx` (the list), `SummaryPanel.tsx`, `Uploads.tsx`, `Replay.tsx` (the Replayer)                                                                            |
| `frontend/src/live/`              | dim-controller's frontend (cbcd274), its bridge connection swapped for the playback websocket (`core/transport.ts`, `core/video.ts`)                                |
| `frontend/src/replay/`            | the Replayer's timeline                                                                                                                                             |
| `frontend/src/dim-app/`           | dim-app (theme, zenoh connection, useBackendState, events), vendored at the tag in `VERSION`; `backend/dim-app/`: its relay publisher                               |
| `scripts/replay_rss.ts`           | the backend's peak memory while a recording is opened, scrubbed end to end and played                                                                               |
| `scripts/make_test_recordings.ts` | short clips with shifted times (for the date sections) and a raw-LCM `.mcap` (which Foxglove can't draw)                                                            |

## Development

```sh
deno task test && deno task check     # backend tests (tiny .db/.mcap files made on the fly), dimos.yaml ↔ routes check
cd frontend && npm install && npm run build
deno run -A backend/main.ts --port 8787 --recordings-dir <dir> --data-dir <dir> [--desktop-url http://127.0.0.1:7341]
nix build .#dimosApp                  # what Desktop builds: bin/dimos-app-server
cd backend/bundle && npm install && node build.mjs   # the one-file backend the nix build runs (no downloads at run time)
```

Converting runs dtk at a pinned commit (`DTK_COMMIT` in `backend/recordings/convert.ts`, fetched by deno on first use;
`DIM_RECORDINGS_DTK="deno run -A <checkout>/main.js"` overrides it); previews need ffmpeg (the nix build brings it).

Licensed under Apache-2.0.
