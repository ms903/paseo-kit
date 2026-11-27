import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionSpeedSample } from "../shared/speed";
import { sessionTarget } from "./sessions";

type AgentHandle = ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>;
type Timeline = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineRow = Timeline["entries"][number];

const SPEED_LABELS = [
  ["Response", "response"],
  ["Whole turn", "whole-turn"],
  ["Speed", "model-time"],
] as const;
const MAX_NATIVE_RATE = 5_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 4;
const MAX_TURNS = 12;

function durationMs(value?: string): number | undefined {
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(value ?? "");
  if (seconds) return Number(seconds[1]) * 1_000;
  const minutes = /^(\d+)m (\d+)s$/.exec(value ?? "");
  return minutes ? (Number(minutes[1]) * 60 + Number(minutes[2])) * 1_000 : undefined;
}

function outputFromTokens(value?: string): { count: number; rounded: boolean } | undefined {
  const match = /^\d+(?:\.\d+)?[KM]? ↑ · (\d+(?:\.\d+)?)([KM]?) ↓$/.exec(value ?? "");
  if (!match) return;
  const unit = match[2];
  return { count: Number(match[1]) * (unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : 1), rounded: !!unit };
}

export function recordedTurnSpeeds(row: TimelineRow, epoch: string): SessionSpeedSample[] {
  const timestamp = Date.parse(row.timestamp);
  if (!row.turnMetrics?.length || !Number.isFinite(timestamp)) return [];

  const measuredAt = new Date(timestamp).toISOString();
  const turnId = row.turnId || `${epoch}:${row.seqEnd}`;
  const metrics = new Map(row.turnMetrics.map(({ label, value }) => [label, value]));
  const ttftMs = durationMs(metrics.get("TTFT"));
  const samples: SessionSpeedSample[] = [];

  for (const [label, basis] of SPEED_LABELS) {
    const value = /^([~≈])?(\d+(?:\.\d+)?) tok\/s$/.exec(metrics.get(label) ?? "");
    if (!value) continue;
    const tokensPerSecond = Number(value[2]);
    if (tokensPerSecond <= 0 || tokensPerSecond > MAX_NATIVE_RATE) continue;
    samples.push({ turnId, measuredAt, basis, tokensPerSecond, approximate: Boolean(value[1]), source: "provider", ttftMs });
  }
  if (samples.length) return samples;

  // Claude can supply measured output and API time without emitting a native
  // rate. The SDK's displayed fields have already been rounded.
  if (row.provider !== "claude") return [];
  const output = outputFromTokens(metrics.get("Tokens"));
  const modelTime = durationMs(metrics.get("Model time"));
  if (!output || !modelTime || modelTime < 100) return [];
  const tokensPerSecond = output.count * 1_000 / modelTime;
  if (tokensPerSecond <= 0 || tokensPerSecond > MAX_NATIVE_RATE) return [];
  return [{
    turnId, measuredAt, basis: "model-time", tokensPerSecond, approximate: true, source: "provider", ttftMs,
    outputTokens: output.rounded || !Number.isSafeInteger(output.count) ? undefined : output.count,
  }];
}

export interface SpeedHistory {
  turns: SessionSpeedSample[];
  hasOlder: boolean;
}

export interface SpeedSession {
  provider: string;
  sessionId: string;
}

export function speedSession(agent: Timeline["agent"] | undefined): SpeedSession | undefined {
  if (!agent || agent.internal) return;
  const { provider, sessionId } = sessionTarget(agent);
  if (provider && sessionId) return { provider, sessionId: provider === "codex" ? sessionId.toLowerCase() : sessionId };
}

export async function readCompletedTurnSpeed(agent: Pick<AgentHandle, "timeline">, turnId: string) {
  const result = await agent.timeline.refetch({ direction: "tail", limit: 24 });
  const rows = result.entries.filter((row) => row.turnId === turnId);
  if (!result.agent || !rows.length) return;
  return { agent: result.agent, samples: rows.flatMap((row) => recordedTurnSpeeds(row, result.epoch)) };
}

export async function readSpeedHistory(agent: Pick<AgentHandle, "timeline">, expected: SpeedSession): Promise<SpeedHistory> {
  const turns = new Map<string, SessionSpeedSample[]>();
  let cursor: Timeline["startCursor"] = null;
  let epoch: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await agent.timeline.refetch({
      direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: PAGE_LIMIT,
    });
    const target = speedSession(result.agent);
    if (!target || target.provider !== expected.provider || target.sessionId !== expected.sessionId) {
      return { turns: [], hasOlder: false };
    }
    // A rewind/import can replace a timeline between pages. Rows from the old
    // epoch cannot establish history in the new one.
    if (epoch !== undefined && (epoch !== result.epoch || result.reset || result.staleCursor || result.gap)) {
      return { turns: [], hasOlder: true };
    }
    epoch = result.epoch;
    for (const row of [...result.entries].reverse()) {
      const samples = recordedTurnSpeeds(row, result.epoch);
      const id = samples[0]?.turnId;
      if (!id || turns.has(id)) continue;
      if (turns.size >= MAX_TURNS) return { turns: [...turns.values()].flat(), hasOlder: true };
      turns.set(id, samples);
    }
    if (!result.hasOlder) return { turns: [...turns.values()].flat(), hasOlder: false };
    if (!result.startCursor || result.startCursor.seq === cursor?.seq) break;
    cursor = result.startCursor;
  }
  return { turns: [...turns.values()].flat(), hasOlder: true };
}
