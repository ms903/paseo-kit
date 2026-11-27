# media-studio

Review the images, video and audio your agents make: cards in the chat, a streaming player with a
filmstrip and waveform timeline, timecoded notes back to the agent, and uploads and downloads of
large files. Files on SSH hosts, such as a GPU render box, work too.

See [OVERVIEW.md](OVERVIEW.md) for what it does and its limits.

## Install

```bash
paseo plugin install github:ms903/paseo-kit:plugins/media-studio
```

To update a GitHub installation on Paseo 0.18.1, run `paseo plugin update media-studio`. The command shows the available revision for review and keeps the existing plugin ID and settings.

For a local checkout of [paseo-kit](../../README.md), run

```bash
cd plugins/media-studio && npm ci
paseo plugin install "$PWD"
```

Media Studio 0.1.0 targets the Paseo 0.18.1 SDK and retains the Paseo 0.15.3 minimum for the daemon and app. Enable plugins and install ffmpeg on the daemon host for media previews. On Windows, put the directory containing `ffmpeg.exe` and `ffprobe.exe` on the daemon’s PATH or enter their full paths in Media Studio settings.

## How it works

| Piece | Where |
| --- | --- |
| Playback | `server/stream.ts` runs one ffmpeg per session writing fragmented MP4 from a start time; `client/web.ts` (`StreamPlayer`) appends it to a MediaSource and opens a new session when you seek outside the buffer. H.264 is copied from the keyframe at or before the seek point, or, when that keyframe is far back, a near-lossless "bridge" is encoded from the seek point to the next keyframe (keyframe index from `-skip_frame nokey`) and the copy continues there; everything else is converted. Each session reports its first sample's time, which becomes the SourceBuffer `timestampOffset`. |
| Frames, filmstrip, waveform | `server/stills.ts`, cached on disk by `server/cache.ts`. |
| Hosts | `server/hosts.ts`: the daemon host, or `alias:/path` over multiplexed SSH, where the remote ffmpeg does the work. |
| Transfers | `server/transfer.ts` and `client/transfers.ts`: 1 MB upload and 4 MB download pieces over plugin RPC, out of order, into a hidden part file renamed when complete. The daemon assigns each upload its own ID, verifies the content fingerprint on resume, and saves received ranges under `~/.cache/paseo-media-studio/uploads`. A plugin reload hands active, paused and queued files to the same daemon while the page stays open. |
| Agent tool and turn cards | `server/agent.ts`: `preview_media` through `agent.open.before`; a card appended after each turn's reply. `index.client.tsx` turns the tool call into the same card while it runs. |
| Composer pill | `client/pill.tsx` and `server/project.ts`: a "Media N" pill for agents whose folder holds video or audio over 256 KB, or at least 20 images; it opens the media panel. Enable `composerPill` in settings to scan the agents’ folders. |
| `.ts` and `.mts` | Also TypeScript. The file panel does not claim them; scans and folder lists keep one only when its first bytes are a transport stream (`dropSourceCode` in `server/files.ts`). |

The plugin uses base64 and polling over JSON RPC to support Paseo 0.15.3 through 0.18.1.

## Develop

```bash
npm run typecheck
paseo plugin reload media-studio
paseo plugin logs media-studio
```
