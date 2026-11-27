# host-monitor

CPU, memory, GPU, disk and network usage of the daemon host in the sidebar footer.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works and its limits.

## Install

```bash
paseo plugin install github:ms903/paseo-kit:plugins/host-monitor
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/host-monitor && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.11.1 or later with plugins enabled on the daemon.

## Settings

Open **Settings → Plugins → Host monitor** on the selected host. CPU, memory, GPU, disk and network are all enabled in the footer by default. Switch off the readings you want to hide. With all five switched off, the footer stops polling. The details page shows every available reading.

The refresh interval defaults to 2 seconds. Choose 5, 10 or 30 seconds for fewer requests from an open sidebar or details page. Hardware probes keep their own minimum intervals.

## Develop

```bash
npm run typecheck
paseo plugin reload host-monitor
paseo plugin logs host-monitor
```
