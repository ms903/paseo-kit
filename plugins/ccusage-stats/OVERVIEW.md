Shows how many tokens your coding agents use on the machine the Paseo daemon runs on, and what that usage would cost at API prices. Numbers come from [ccusage](https://github.com/ccusage/ccusage), which reads the agents' local session logs. Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode, Antigravity, Grok Build, Amp, Pi and the other agents ccusage supports are counted together.

## Where it appears

A line in the sidebar footer, styled like the built-in usage summary, shows today's total tokens, a small meter and today's cost. The meter compares today's cost, split by agent, with a tick that marks a typical day: the median cost of the active days in the last 28, with idle days skipped. The median keeps a single very heavy day, or a day with one prompt, from moving the tick far. Cost is used rather than tokens because cache reads make up most of the token count while costing next to nothing. The tick sits mid-track, so a half-full meter means a typical day; past double the typical day the track stretches and the tick slides left. Today is compared as it stands, so the meter fills over the course of the day. With no usage in the last 28 days, the typical day defaults to about $78, which is 20% of the monthly API-equivalent value of a $200 Claude Max 20x plan on Opus 5.5 (about $11,726) as measured by SemiAnalysis in October 2026 ([summary](https://www.explainx.ai/blog/semianalysis-claude-vs-chatgpt-subscription-api-value-limit-testing-2026)), spread over 30 days. The tick is muted while the default is in use. The popover's day view states the typical day in numbers, together with the average cost per day: everything spent since the first active day in the window, idle days included, divided by the days since then, and that average over 30 days. The average is what usage costs over time, the figure to hold against a plan's price; the typical day is what a working day looks like. On a narrow sidebar the bar and then the cost are dropped.

Press the line for a popover. Switch between day, week and month to see the current period's total, the change against the previous one, and a stacked column chart of recent periods. Press a column to inspect that period. Below the chart, each agent's tokens, share and cost are listed. **Details** opens a full screen with longer history (30 days, 12 weeks or 12 months), cost per million tokens, cache hit rate, the input, output and cache split, a per-agent list that expands into models, and the most recent sessions. The screen is also in the Command Center as **Open token usage**.

Each agent's composer gets a pill with the token total of that agent's current session once usage is recorded. Press it for the session's cost, token split and models.

## How sessions are matched

Paseo stores each agent's provider session id. For Claude Code this is the session id ccusage reports. For Codex it is the thread id at the end of the rollout name. For Antigravity it is the conversation id inside the provider's saved session, which matches the name of the conversation database. The pill follows the provider session when an agent resumes into a new session.

## Freshness

All views share the daemon's usage cache. On the first read it loads daily history. Subsequent reads rescan from the day before that pass and rebuild week and month totals from the daily rows. While the monitor is in use, it rereads the older days after six hours to pick up historical edits. Session totals use a separate full scan so a resumed conversation keeps its earlier turns. The two ccusage scans run one at a time with a five-minute limit each. Slow scans and failures increase the interval between attempts. A failed session scan keeps the last session totals and the calendar can still update.

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
