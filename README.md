# Paseo 0.18.1 — new agent composer reproduction

These files accompany a bug report about editing a long, unsent prompt in a New Agent tab. The test used the official Linux Electron package on Debian 13 (x86-64, X11/Xvfb) and an isolated local daemon. No plugins were installed and no message was sent.

- `paseo-new-agent-composer-repro.mp4` is a 24-second recording comparing drafts containing 1,000 and 250,000 synthetic characters. The timing box is an overlay added by the test harness.
- `paseo-new-agent-composer.png` shows the long draft near the end of the recording.
- `desktop-short-to-long.ndjson` and `desktop-long-to-short.ndjson` are the raw logs from two separate timing runs, with 20 typed keys per draft. Each `inputs` pair records milliseconds from the paste or keydown event to the input event and to the second animation-frame callback after the input event. The first pair is the paste. The rest are individual keystrokes. The `longTasks` values are Chromium Long Tasks durations in milliseconds over the same interval.
