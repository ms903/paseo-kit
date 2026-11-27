# tab-recovery

Reopen agent tabs that were closed by accident.

See [OVERVIEW.md](OVERVIEW.md) for what it does, how it works and its limits.

## Install

```bash
paseo plugin install github:ms903/paseo-kit:plugins/tab-recovery
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/tab-recovery && npm install
paseo plugin install "$PWD"
```

Supports Paseo 0.11.1 or later with plugins enabled on the daemon. On Paseo 0.18.1, the plugin restores agents using the connected daemon's SDK. Older hosts that lack the SDK reload method need the matching `paseo` CLI on the daemon's PATH.

## Develop

```bash
npm run typecheck
paseo plugin reload tab-recovery
paseo plugin logs tab-recovery
```
