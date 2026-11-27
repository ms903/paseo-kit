# ms903's Paseo plugins

[中文](README.md) · [Maintainer guide (Chinese)](docs/maintenance.md) · [Changelog](CHANGELOG.md)

ms903 maintains this collection against **Paseo 0.18.1**. Each plugin has its own installation and update history. Existing Git installations keep their plugin IDs and paths. [Host release](https://github.com/getpaseo/paseo/releases/tag/v0.18.1)

| Plugin | Purpose |
| --- | --- |
| [heartbeat-status](plugins/heartbeat-status) | See which agents have an active heartbeat of their own or through a descendant on the agent tab and workspace sidebar on web and desktop. Requires Paseo 0.18.1 or later. |
| [tab-recovery](plugins/tab-recovery) | Reopen an archived top-level agent in the current workspace. |
| [media-studio](plugins/media-studio) | Review video, audio and images in chat, send timecoded notes, and transfer media. Previews use FFmpeg on the daemon host. Playback and uploads use the web or desktop client. |
| [file-download](plugins/file-download) | Download the focused file preview on web and desktop with Ctrl+S or Cmd+S. The shortcut still saves edits inside the editor. |
| [paseo-latex-companion](plugins/paseo-latex-companion) | Render inline, display and table formulas on web and desktop alongside official Better Paseo with its Markdown renderer enabled. |
| [host-monitor](plugins/host-monitor) | Read CPU, memory, disk, network and available GPU metrics for the selected host. |
| [ccusage-stats](plugins/ccusage-stats) | See token counts, output speed, estimated costs and historical usage for the selected session. Installation runs npm on the daemon host. |

## Install and update

Enable plugins in **Settings → Plugins** on the target daemon. Choose a plugin ID from the table and substitute it for `tab-recovery` in these commands.

```sh
paseo plugin install git:ms903/paseo-kit:plugins/tab-recovery
paseo plugin update tab-recovery --check
paseo plugin update tab-recovery
paseo plugin ls
```

To install a specific revision, append `--ref <tag-or-commit>`. To return to a known revision of an existing Git installation, run `paseo plugin update <id> --ref <tag-or-commit>`. [Git source reference](https://github.com/getpaseo/paseo/blob/v0.18.1/docs/plugins.md#install-a-git-source)

## Configure in Paseo

Open **Settings → the host → Plugins** and choose an installed plugin. Its header controls activation.

| Plugin | Settings |
| --- | --- |
| Heartbeat Status | Teal, blue, purple or amber clock. Continuous motion is on by default and respects Reduce Motion. |
| Token Usage | Show session speed, choose the composer reading (live, average decode or whole turn), and set the live window. Defaults to on, live, 5 seconds. |
| Closed agents | Show the last 10, 25 or 50 closed agents per workspace. Default 50. |
| Download file | Enable the Ctrl+S / Cmd+S download shortcut. The command center action is always available. |
| Host Monitor | Toggle five sidebar metrics individually. CPU and memory refresh every 2, 5, 10 or 30 seconds. Default 2. |
| Media Studio | Configure playback quality, encoding, FFmpeg paths, storage folders, remote hosts, agent tools, turn cards and the composer shortcut. |
| LaTeX Companion | Set formula size to 100%, 110%, 125% or 150% and toggle table typesetting. Preferences follow the reading client. |

The clocks use the IBM Carbon palette. Session throughput integrates Drenalol’s Turn Speed meter and labels estimates where applicable. [IBM Design Language](https://www.ibm.com/design/language/color/) · [Turn Speed](https://github.com/Drenalol/paseo-turn-speed)

## License and provenance

This collection derives from a31521424/paseo-kit and retains its copyright notices and commit history. The repository uses Apache-2.0. The LaTeX companion includes KaTeX, Marked and fonts under their respective licenses. [Upstream](https://github.com/a31521424/paseo-kit) · [LICENSE](LICENSE) · [NOTICE](NOTICE) · [Third-party licenses](plugins/paseo-latex-companion/licenses)
