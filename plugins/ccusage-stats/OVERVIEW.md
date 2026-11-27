Shows how many tokens your coding agents use on the machine the Paseo daemon runs on, and what that usage would cost at API prices. Numbers come from [ccusage](https://github.com/ccusage/ccusage), which reads the agents' local session logs. Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode, Antigravity, Grok Build, Amp, Pi and the other agents ccusage supports are counted together.

## Where it appears

A line in the sidebar footer, styled like the built-in usage summary, shows today's total tokens, a small meter and today's cost. The meter compares today's cost, split by agent, with a tick that marks a typical day: the median cost of the active days in the last 28, with idle days skipped. The median keeps a single very heavy day, or a day with one prompt, from moving the tick far. Cost is used rather than tokens because cache reads make up most of the token count while costing next to nothing. The tick sits mid-track, so a half-full meter means a typical day; past double the typical day the track stretches and the tick slides left. Today is compared as it stands, so the meter fills over the course of the day. With no usage in the last 28 days, the typical day defaults to about $78, which is 20% of the monthly API-equivalent value of a $200 Claude Max 20x plan on Opus 5.5 (about $11,726) as measured by SemiAnalysis in October 2026 ([summary](https://www.explainx.ai/blog/semianalysis-claude-vs-chatgpt-subscription-api-value-limit-testing-2026)), spread over 30 days. The tick is muted while the default is in use. The popover's day view states the typical day in numbers, together with the average cost per day: everything spent since the first active day in the window, idle days included, divided by the days since then, and that average over 30 days. The average is what usage costs over time, the figure to hold against a plan's price; the typical day is what a working day looks like. On a narrow sidebar the bar and then the cost are dropped.

Press the line for a popover. Switch between day, week and month to see the current period's total, the change against the previous one, and a stacked column chart of recent periods. Press a column to inspect that period. Below the chart, each agent's tokens, share and cost are listed. **Details** opens a full screen with longer history (30 days, 12 weeks or 12 months), cost per million tokens, cache hit rate, the input, output and cache split, a per-agent list that expands into models, and the most recent sessions. The screen is also in the Command Center as **Open token usage**.

Open **Token Usage** in an agent’s composer for session tokens, estimated cost, cache hit rate, context, and output speed. On current Paseo the same button shows the speed of the focused conversation during a turn and returns to the session’s token count afterwards. Its details distinguish model output, tool or permission waits, and work delegated to child agents. On older clients without a focused-composer API, opening the panel starts live observation.

**Settings → the host → Plugins → Token usage** controls speed visibility, the composer reading (live, average decode, or whole turn excluding waits), and the live window (3, 5, 10 or 30 seconds). The defaults are on, live, and 5 seconds.

A live stream can show an estimated rate before the provider reports token counts. The **≈** sign identifies those estimates. Turn details can show time to first token, reasoning, tools and subagent activity when observed. Opening a session in the report shows available per-turn measurements from the provider or a completed turn the client observed. An old session with neither source displays an unavailable state. History stays scoped to the selected provider session when the same Paseo agent changes sessions.

The live meter uses Drenalol’s MIT-licensed Turn Speed implementation. [Upstream](https://github.com/Drenalol/paseo-turn-speed) · [MIT license and copyright](client/turn-speed/LICENSE)

## How sessions are matched

Paseo stores each agent's provider session id. For Claude Code this is the session id ccusage reports. For Codex it is the thread id at the end of the rollout name. For Antigravity it is the conversation id inside the provider's saved session, which matches the name of the conversation database. The pill follows the provider session when an agent resumes into a new session.

## Freshness

The daemon saves its report under `$PASEO_HOME/cache/ccusage-stats/` (normally `~/.paseo/cache/ccusage-stats/`). After a restart or plugin update, the sidebar and details open from the saved report. A complete report refreshed within the last 45 minutes is reused. On the first scan, the sidebar and details show today's token breakdown and available costs as soon as recent daily counts and Antigravity usage are ready. Costs that depend on individual requests fill in after the recent session scan. The calendar then expands to 30 days, 12 weeks and 12 months while lifetime session totals finish in the background. Each stage saves its results, and an open view shows the current scan and its elapsed time.

Automatic scans start at most once every 45 minutes while the app is reading usage. **Refresh usage** in the details or **Refresh** in the popover starts a check immediately or joins a scan already in progress. The next 45-minute interval starts when the scan completes. A failed daily scan backs off while the last report remains available. Updating model prices reuses usage already loaded for the current day.

The daemon caches finished dates and requests only the current date on regular scans. When the date advances, it fills the gap once and archives those days, including prior usage from resumed sessions. Session scans are skipped when daily totals are unchanged, with a separate hourly verification interval. Every 30 days an automatic refresh can reconcile older records. The **Total** view includes the full available history. While a scan runs, a view with the current report receives only status updates until the totals change.

Antigravity database and WAL signatures and Codex rollout signatures identify changes to model-pricing inputs. Only aggregate counts and pricing bands are cached. The compressed usage files have a combined limit of 13 MiB per daemon. A price update reuses available totals.

## Setup and limits

ccusage is bundled with the plugin, so nothing needs to be on the daemon's `PATH`. The bundled build covers macOS, Linux and Windows on x64 and arm64; elsewhere a `ccusage` on the daemon's `PATH` is used. Requires Paseo 0.11.1 or later.

Days and weeks use the daemon's timezone, and weeks start on Monday. The daemon reads usage from
local logs. **Update prices** in Token usage fetches the public Models.dev catalog and recalculates
the report. The daemon saves the catalog for later reports. GPT-6.2 Sol, GPT-6.2 Astra, Gemini 4
Hydrogen, and Gemini 4 Neon have built-in rates.

Antigravity app, IDE and CLI are included. The plugin reads generation metadata from
`~/.gemini/antigravity*/conversations/*.db`, including committed WAL updates, and groups
usage by the daemon timezone. Mirrored conversation IDs are counted once; backup stores
are excluded. Set `GEMINI_DIR` to use another data root. Requires Node.js 22.13+.
