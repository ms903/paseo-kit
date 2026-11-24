import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { z } from "zod";
import type { UsageStore } from "./usage-store";
import type { RawReport, RawRow } from "./ccusage";
import { weekOf } from "./usage-rows";
import {
  findModelPrice,
  priceTokens,
  pricingDeadline,
  type ModelPrice,
  type PriceCatalog,
  type TokenCounts,
} from "./price-catalog";

// Standard rates for GPT-6.2, including prompts over 272K input tokens.
// https://developers.openai.com/api/docs/pricing
const GPT62_PRICES = new Map<string, ModelPrice>([
  [
    "gpt-6.2-sol",
    {
      standard: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      context: [
        {
          above: 272_000,
          rates: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
        },
      ],
    },
  ],
  [
    "gpt-6.2-astra",
    {
      standard: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
      context: [
        {
          above: 272_000,
          rates: { input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 },
        },
      ],
    },
  ],
]);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_FILES = 512;
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;
const ZERO_TOKENS: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};
const ULTRAFAST_PRICE_CHANGE = Date.parse("2027-03-01T00:00:00-08:00");
const PERIODS = ["daily", "weekly", "monthly", "session"] as const;

function gpt62Id(model: string): string {
  return model
    .replace(/^openai\//, "")
    .replace(/-fast$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function gpt62Price(
  catalog: PriceCatalog,
  model: string,
): ModelPrice | undefined {
  const id = gpt62Id(model);
  const builtin = GPT62_PRICES.get(id);
  if (!builtin) return;
  const live = findModelPrice(catalog, `openai/${id}`);
  return live?.context.length ? live : builtin;
}

const bucketSchema = z.object({
  model: z.string(), day: z.iso.date(), contextSize: z.number(), multiplier: z.number(),
  tokens: z.object({
    inputTokens: z.number(), outputTokens: z.number(),
    cacheReadTokens: z.number(), cacheCreationTokens: z.number(),
  }),
});
type Bucket = z.infer<typeof bucketSchema>;

interface PricedUsage extends TokenCounts {
  cost: number;
}

function addTokens(total: TokenCounts, counts: TokenCounts): void {
  for (const key of TOKEN_FIELDS) total[key] += counts[key];
}

function sameTokens(a: TokenCounts, b: TokenCounts): boolean {
  return TOKEN_FIELDS.every((key) => a[key] === b[key]);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export function usageFrom(raw: Record<string, unknown>): TokenCounts {
  return {
    inputTokens: number(raw.input_tokens ?? raw.prompt_tokens ?? raw.input),
    outputTokens: number(
      raw.output_tokens ?? raw.completion_tokens ?? raw.output,
    ),
    cacheReadTokens: number(
      raw.cached_input_tokens ??
        raw.cache_read_input_tokens ??
        raw.cached_tokens,
    ),
    cacheCreationTokens: number(
      raw.cache_write_input_tokens ?? raw.cache_creation_input_tokens,
    ),
  };
}

interface RolloutRecord {
  type: string;
  timestamp: string;
  payload?: {
    type?: string;
    model?: string;
    model_name?: string;
    metadata?: { model?: string };
    thread_settings?: { service_tier?: string };
    response_id?: string;
    compaction_response_id?: string;
    usage?: Record<string, unknown>;
    thread_token_usage?: Record<string, unknown>;
    info?: {
      last_token_usage?: Record<string, unknown>;
      total_token_usage?: Record<string, unknown>;
      model?: string;
      model_name?: string;
    };
  };
}

function speedMultiplier(
  tier: string | undefined,
  model: string,
  at: number,
): number {
  if (tier === "ultrafast") return at < ULTRAFAST_PRICE_CHANGE ? 3 : 6;
  if (
    tier === "fast" ||
    tier === "priority" ||
    (!tier && model.endsWith("-fast"))
  )
    return 2;
  return tier === "flex" ? 0.5 : 1;
}

async function readRollout(
  file: string,
  timezone: string,
  bounds: number[],
  signal: AbortSignal,
): Promise<Bucket[]> {
  const source = createReadStream(file, { signal });
  const decompressor = file.endsWith(".zst")
    ? zlib.createZstdDecompress()
    : undefined;
  let bytes = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES)
        callback(new Error("Rollout exceeds pricing scan limit"));
      else callback(null, chunk);
    },
  });
  const completion = decompressor
    ? pipeline(source, decompressor, capped, { signal })
    : pipeline(source, capped, { signal });
  // The reader also sees stream errors. Attach a handler before its first read.
  void completion.catch(() => undefined);
  const lines = createInterface({ input: capped, crlfDelay: Infinity });
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const buckets = new Map<string, Bucket>();
  let model = "";
  let tier: string | undefined;
  let previous = ZERO_TOKENS;
  const pending = new Map<
    string,
    {
      model: string;
      date: string;
      tier?: string;
      tokens: TokenCounts;
      cumulative?: TokenCounts;
    }
  >();
  const compacted = new Set<string>();
  const counted = new Set<string>();
  let latestResponse: string | undefined;

  function record(
    model: string,
    date: string,
    tier: string | undefined,
    raw: TokenCounts,
  ): void {
    if (
      !GPT62_PRICES.has(gpt62Id(model)) ||
      !TOKEN_FIELDS.some((key) => raw[key] > 0)
    )
      return;
    const at = Date.parse(date);
    if (!Number.isFinite(at)) return;
    const tokens = { ...raw };
    const prompt = tokens.inputTokens;
    tokens.cacheReadTokens = Math.min(tokens.cacheReadTokens, prompt);
    tokens.cacheCreationTokens = Math.min(
      tokens.cacheCreationTokens,
      prompt - tokens.cacheReadTokens,
    );
    tokens.inputTokens -= tokens.cacheReadTokens + tokens.cacheCreationTokens;
    const boundary = bounds.findLast((value) => prompt > value);
    const contextSize = boundary === undefined ? 0 : boundary + 1;
    const day = dayFormat.format(at);
    const multiplier = speedMultiplier(tier, model, at);
    const key = JSON.stringify([model, day, contextSize, multiplier]);
    const bucket = buckets.get(key) ?? {
      model,
      day,
      contextSize,
      multiplier,
      tokens: { ...ZERO_TOKENS },
    };
    addTokens(bucket.tokens, tokens);
    buckets.set(key, bucket);
  }

  function applyCompaction(id: string) {
    const turn = pending.get(id);
    if (!turn || counted.has(id)) return;
    record(turn.model, turn.date, turn.tier, turn.tokens);
    counted.add(id);
    pending.delete(id);
  }

  try {
    for await (const line of lines) {
      if (
        line.length > 256 * 1024 ||
        !/"(?:token_count|turn_context|thread_settings_applied|token_usage_record|compacted)"/.test(
          line,
        )
      )
        continue;
      let entry: RolloutRecord;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry?.payload;
      if (!payload) continue;
      const recordedModel =
        payload.model ??
        payload.model_name ??
        payload.metadata?.model ??
        payload.info?.model ??
        payload.info?.model_name;
      if (entry.type === "turn_context") {
        if (typeof recordedModel === "string" && recordedModel)
          model = recordedModel;
        continue;
      }
      if (
        entry.type === "compacted" &&
        typeof payload.compaction_response_id === "string"
      ) {
        compacted.add(payload.compaction_response_id);
        applyCompaction(payload.compaction_response_id);
        continue;
      }
      if (
        entry.type === "token_usage_record" &&
        payload.usage &&
        typeof payload.response_id === "string"
      ) {
        const id = payload.response_id;
        if (counted.has(id)) continue;
        latestResponse = id;
        if (!pending.has(id)) {
          pending.set(id, {
            model: recordedModel ?? model,
            date: entry.timestamp,
            tier,
            tokens: usageFrom(payload.usage),
            cumulative: payload.thread_token_usage
              ? usageFrom(payload.thread_token_usage)
              : undefined,
          });
        }
        if (compacted.has(id)) applyCompaction(id);
        continue;
      }
      if (entry.type !== "event_msg") continue;
      if (payload.type === "thread_settings_applied") {
        tier = payload.thread_settings?.service_tier ?? tier;
        continue;
      }
      if (payload.type !== "token_count" || !payload.info) continue;
      const { last_token_usage: last, total_token_usage: total } = payload.info;
      const cumulative = total ? usageFrom(total) : null;
      if (last && cumulative && sameTokens(previous, cumulative)) continue;
      const tokens = last ? usageFrom(last) : { ...ZERO_TOKENS };
      if (cumulative) {
        if (!last)
          for (const k of TOKEN_FIELDS)
            tokens[k] = Math.max(cumulative[k] - previous[k], 0);
        previous = cumulative;
      }
      if (typeof recordedModel === "string" && recordedModel)
        model = recordedModel;
      const pendingTurn = latestResponse
        ? pending.get(latestResponse)
        : undefined;
      if (
        latestResponse &&
        pendingTurn &&
        (sameTokens(tokens, pendingTurn.tokens) ||
          (cumulative &&
            pendingTurn.cumulative &&
            sameTokens(cumulative, pendingTurn.cumulative)))
      ) {
        // Local compaction also appears in token_count. Remote compaction only has the usage record.
        counted.add(latestResponse);
        pending.delete(latestResponse);
      }
      record(model, entry.timestamp, tier, tokens);
    }
    await completion;
    return [...buckets.values()];
  } finally {
    lines.close();
    source.destroy();
    capped.destroy();
    decompressor?.destroy();
  }
}

export function codexHomes(): string[] {
  const roots = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return roots
    .split(",")
    .map((dir) => dir.trim().replace(/^~(?=[/\\])/, os.homedir()))
    .filter(Boolean);
}

export async function rolloutSource(session: string, homes: string[]) {
  const segments = session.split(/[/\\]/);
  if (
    segments.some(
      (part) => !part || part === "." || part === ".." || part.includes(":"),
    )
  )
    return;
  for (const home of homes) {
    for (const folder of ["sessions", "archived_sessions", ""]) {
      const file = path.join(home, folder, ...segments) + ".jsonl";
      const candidates =
        typeof zlib.createZstdDecompress === "function"
          ? [file, `${file}.zst`]
          : [file];
      for (const candidate of candidates) {
        const stat = await fs.stat(candidate).catch(() => null);
        if (stat?.isFile()) return { file: candidate, stat };
      }
    }
  }
}

function periodKey(kind: keyof RawReport, day: string, session: string): string {
  switch (kind) {
    case "session": return session;
    case "weekly": return weekOf(day);
    case "monthly": return day.slice(0, 7);
    case "daily": return day;
  }
}

export type ReportPrices = (report: RawReport, sessionsKnownFrom?: string) => void;

/** Reuse the same request-level prices as the calendar grows from recent days to a full year. */
export function createReportPricer(homes = codexHomes(), store?: UsageStore, readFile = readRollout) {
  const index = store?.fileIndex("codex", z.array(bucketSchema));
  const cached = new Map<string, { signature: string; buckets: Bucket[] }>();

  return async function preparePrices(
    sessionSources: RawRow[],
    timezone: string,
    catalog: PriceCatalog,
    signal: AbortSignal,
    sections: readonly (keyof RawReport)[] = PERIODS,
    onRead?: (id: string) => () => void,
  ): Promise<ReportPrices> {
    const tallies = {
      daily: new Map<string, PricedUsage>(),
      weekly: new Map<string, PricedUsage>(),
      monthly: new Map<string, PricedUsage>(),
      session: new Map<string, PricedUsage>(),
    };
    const bounds = [
      ...new Set(
        [...GPT62_PRICES.keys()].flatMap((model) =>
          gpt62Price(catalog, model)!.context.map((tier) => tier.above),
        ),
      ),
    ].sort((a, b) => a - b);
    const sessions = sessionSources.filter(
      (row) =>
        row.agent === "codex" &&
        row.modelBreakdowns.some((model) =>
          gpt62Price(catalog, model.modelName),
        ),
    );
    sessions.sort((a, b) =>
      (b.metadata?.lastActivity ?? "").localeCompare(
        a.metadata?.lastActivity ?? "",
      ),
    );
    const budget = pricingDeadline(signal);
    let cursor = 0;

    async function readSessions() {
      while (cursor < sessions.length && !budget.aborted) {
        const session = sessions[cursor++]!;
        const source = await rolloutSource(session.period, homes);
        if (!source || source.stat.size > MAX_FILE_BYTES || budget.aborted)
          continue;
        const { size, mtimeMs, ctimeMs, ino } = source.stat;
        const signature = `${size}:${mtimeMs}:${ctimeMs}:${ino}:${timezone}:${bounds.join(",")}`;
        const cachedFile = cached.get(source.file);
        let buckets = cachedFile?.signature === signature ? cachedFile.buckets : await index?.get(source.file, signature);
        if (!buckets) {
          if (budget.aborted) continue;
          const fileName = path.basename(source.file);
          const uuid = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.jsonl)/i.exec(fileName);
          const done = onRead?.(uuid?.[1] ?? fileName.slice(0, 12));
          try {
            buckets = await readFile(source.file, timezone, bounds, budget).catch(() => undefined);
          } finally {
            done?.();
          }
          if (!buckets) continue;
          await index?.set(source.file, signature, buckets);
        }
        cached.delete(source.file);
        cached.set(source.file, { signature, buckets });
        if (cached.size > MAX_CACHED_FILES)
          cached.delete(cached.keys().next().value!);

        for (const bucket of buckets) {
          const price = gpt62Price(catalog, bucket.model);
          if (!price) continue;
          const cost =
            priceTokens(bucket.tokens, price, bucket.contextSize) *
            bucket.multiplier;
          for (const kind of sections) {
            const key = JSON.stringify([periodKey(kind, bucket.day, session.period), bucket.model]);
            const total = tallies[kind].get(key) ?? { ...ZERO_TOKENS, cost: 0 };
            addTokens(total, bucket.tokens);
            total.cost += cost;
            tallies[kind].set(key, total);
          }
        }
      }
    }

    if (sessions.length) {
      await Promise.all([readSessions(), readSessions()]);
      if (!signal.aborted) await index?.flush();
    }
    return (report, sessionsKnownFrom) => {
      for (const kind of sections) {
        for (const row of report[kind]) {
          for (const agent of row.agents ?? [row]) {
            if (agent.agent === "antigravity") continue;
            for (const model of agent.modelBreakdowns) {
              const gpt = gpt62Price(catalog, model.modelName);
              const measured =
                agent.agent === "codex" && gpt
                  ? tallies[kind].get(
                      JSON.stringify([row.period, model.modelName]),
                    )
                  : undefined;
              let cost = model.cost;
              if (measured && sameTokens(measured, model)) {
                cost = measured.cost;
              } else {
                const missingSessions = sessionsKnownFrom && kind === "daily" && row.period < sessionsKnownFrom;
                if (missingSessions && agent.agent === "codex" && gpt) {
                  model.costPending = true;
                  continue;
                }
                const price = gpt ?? findModelPrice(catalog, model.modelName);
                // ccusage prices context tiers and DeepSeek's timestamped rates from its own request data.
                const flat = price?.context.length === 0 && !/deepseek-v4-(flash|pro)/i.test(model.modelName);
                if (price && (flat || (model.cost === 0 && (gpt || model.missingPricing)))) {
                  cost = priceTokens(model, price, 0);
                }
              }
              if (model.costPending) delete model.costPending;
              agent.totalCost += cost - model.cost;
              model.cost = cost;
            }
          }
        }
      }
    };
  };
}
