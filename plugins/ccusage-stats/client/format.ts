import type { PeriodKind } from "../shared/usage";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const longDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", month: "long", day: "numeric", year: "numeric",
});
const shortMonth = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const longMonth = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

export function formatTokens(tokens: number): string {
  const value = Math.max(tokens, 0);
  if (value < 999.5) return `${Math.round(value)}`;
  let scaled = value;
  for (const unit of ["K", "M", "B", "T"]) {
    scaled /= 1000;
    // Use the next unit when rounding would display 1000 of the current unit.
    if (scaled < 9.995) return `${scaled.toFixed(2)}${unit}`;
    if (scaled < 99.95) return `${scaled.toFixed(1)}${unit}`;
    if (scaled < 999.5 || unit === "T") return `${Math.round(scaled)}${unit}`;
  }
  return "";
}

export function formatCost(cost: number): string {
  const value = Math.max(cost, 0);
  return value > 0 && value < 0.005 ? "<$0.01" : usd.format(value);
}

export function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${integer.format(percent)}%`;
}

// The report's keys already use the daemon's calendar. UTC keeps browser and host dates aligned.
function dateOf(key: string): Date {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatPeriodShort(kind: PeriodKind, key: string): string {
  const date = dateOf(key);
  return kind === "monthly"
    ? `${shortMonth.format(date)} ’${key.slice(2, 4)}`
    : shortDay.format(date);
}

export function formatPeriodRange(kind: PeriodKind, key: string, through?: string): string {
  const start = dateOf(key);
  if (kind === "daily") return longDay.format(start);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const end = kind === "monthly"
    ? new Date(Date.UTC(year, month + 1, 0))
    : new Date(Date.UTC(year, month, start.getUTCDate() + 6));
  const reportDay = through ? dateOf(through) : end;
  const last = reportDay >= start && reportDay < end ? reportDay : end;
  if (last.valueOf() === start.valueOf()) return longDay.format(start);
  if (last.getUTCFullYear() !== year) return `${longDay.format(start)} – ${longDay.format(last)}`;
  if (last.getUTCMonth() !== month) return `${shortDay.format(start)} – ${shortDay.format(last)}, ${year}`;
  return `${shortDay.format(start)}–${last.getUTCDate()}, ${year}`;
}

export function formatPeriodLong(kind: PeriodKind, key: string, through?: string): string {
  return kind === "monthly" ? longMonth.format(dateOf(key)) : formatPeriodRange(kind, key, through);
}

export function reportTimeFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

export function formatAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes",
  pi: "Pi",
  goose: "Goose",
  kilo: "Kilo",
  copilot: "Copilot CLI",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  kimi: "Kimi",
  qwen: "Qwen",
  openclaw: "OpenClaw",
  grok: "Grok Build",
  zcode: "ZCode",
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** A Codex rollout name or a UUID, shortened to something recognizable. */
export function shortSessionId(id: string): string {
  const tail = id.split(/[/-]/).filter(Boolean);
  const uuidStart = tail.length >= 5 ? tail[tail.length - 5] : undefined;
  return (uuidStart ?? id).slice(0, 8);
}
