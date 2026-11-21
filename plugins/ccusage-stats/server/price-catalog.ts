import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Models.dev publishes each provider's rates in USD per million tokens.
const CATALOG_URL = "https://models.dev/api.json";
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024;
const PROVIDERS = [
  "openai",
  "google",
  "anthropic",
  "xai",
  "deepseek",
  "mistral",
  "zai",
  "moonshotai",
  "alibaba",
] as const;

export interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelPrice {
  standard: Rates;
  context: { above: number; rates: Rates }[];
}

export type PriceCatalog = ReadonlyMap<string, ModelPrice>;
export const EMPTY_CATALOG: PriceCatalog = new Map();

export function pricingDeadline(signal: AbortSignal, timeout = 5_000): AbortSignal {
  // The plugin SDK's React Native types omit these server-side Node methods.
  const nodeSignal = AbortSignal as typeof AbortSignal & {
    any(signals: AbortSignal[]): AbortSignal;
    timeout(ms: number): AbortSignal;
  };
  return nodeSignal.any([signal, nodeSignal.timeout(timeout)]);
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function priceTokens(
  tokens: TokenCounts,
  price: ModelPrice,
  promptSize: number,
): number {
  let rates = price.standard;
  for (const tier of price.context) {
    if (promptSize <= tier.above) break;
    rates = tier.rates;
  }
  return (
    (tokens.inputTokens * rates.input +
      tokens.outputTokens * rates.output +
      tokens.cacheReadTokens * (rates.cacheRead ?? rates.input) +
      tokens.cacheCreationTokens * (rates.cacheWrite ?? rates.input)) /
    1_000_000
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readRates(
  raw: Record<string, unknown>,
  base?: Rates,
): Rates | undefined {
  const input = rate(raw.input) ?? base?.input;
  const output = rate(raw.output) ?? base?.output;
  if (input === undefined || output === undefined) return;
  return {
    input,
    output,
    cacheRead: rate(raw.cache_read) ?? base?.cacheRead,
    cacheWrite: rate(raw.cache_write) ?? base?.cacheWrite,
  };
}

export function parsePriceCatalog(payload: unknown): PriceCatalog {
  const catalog = new Map<string, ModelPrice>();
  const aliases = new Map<string, string>();
  const providers = object(payload);
  for (const provider of PROVIDERS) {
    for (const [id, entry] of Object.entries(
      object(object(providers[provider]).models),
    )) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) continue;
      const cost = object(object(entry).cost);
      const standard = readRates(cost);
      if (!standard) continue;
      const context: ModelPrice["context"] = [];
      for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) {
        const entry = object(tier);
        const band = object(entry.tier);
        const rates = readRates(entry, standard);
        if (
          band.type === "context" &&
          typeof band.size === "number" &&
          Number.isSafeInteger(band.size) &&
          band.size > 0 &&
          rates
        ) {
          context.push({ above: band.size, rates });
        }
      }
      if (
        context.length === 0 &&
        provider === "google" &&
        cost.context_over_200k
      ) {
        const rates = readRates(object(cost.context_over_200k), standard);
        if (rates) context.push({ above: 200_000, rates });
      }
      context.sort((a, b) => a.above - b.above);
      const price = { standard, context };
      catalog.set(`${provider}/${id}`, price);
      if (!catalog.has(id)) catalog.set(id, price);
      if (provider === "google" && id.endsWith("-preview"))
        aliases.set(id.slice(0, -8), `${provider}/${id}`);
    }
  }
  for (const [alias, id] of aliases)
    if (!catalog.has(alias)) catalog.set(alias, catalog.get(id)!);
  return catalog;
}

export function findModelPrice(
  catalog: PriceCatalog,
  name: string,
): ModelPrice | undefined {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/^\[[a-z0-9_-]+\]\s+/, "");
  return (
    catalog.get(id) ??
    catalog.get(id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, ""))
  );
}

async function readCatalogBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing price catalog");
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return body + decoder.decode();
      bytes += result.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES)
        throw new Error("Price catalog exceeds size limit");
      body += decoder.decode(result.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const tokenRate = z.number().min(0);
const ratesSchema = z.object({
  input: tokenRate,
  output: tokenRate,
  cacheRead: tokenRate.optional(),
  cacheWrite: tokenRate.optional(),
});
const catalogFileSchema = z.object({
  etag: z.string().max(4096).nullable(),
  prices: z.array(z.tuple([z.string().max(150), z.object({
    standard: ratesSchema,
    context: z.array(z.object({ above: z.number().int().positive(), rates: ratesSchema })),
  })])),
});

function catalogPath(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "paseo-ccusage-stats", "prices.json");
}

export function createPriceCatalog(signal: AbortSignal, file = catalogPath(), request = fetch) {
  let prices = EMPTY_CATALOG;
  let etag: string | null = null;
  let loading: Promise<void> | undefined;
  let updating: Promise<void> | undefined;

  async function load(): Promise<void> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_CACHE_BYTES) return;
      const saved = catalogFileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      prices = new Map(saved.prices);
      etag = saved.etag;
    } catch {
      // The first run starts with the bundled prices.
    }
  }

  async function read(): Promise<PriceCatalog> {
    loading ??= load();
    await loading;
    return prices;
  }

  function update(): Promise<void> {
    updating ??= (async () => {
      await read();
      const response = await request(CATALOG_URL, {
        credentials: "omit",
        headers: etag ? { "If-None-Match": etag } : undefined,
        signal: pricingDeadline(signal),
      });
      if (response.status === 304 && prices.size) return;
      if (!response.ok) throw new Error(`Price catalog HTTP ${response.status}`);
      const next = parsePriceCatalog(JSON.parse(await readCatalogBody(response)));
      if (!next.size) throw new Error("Empty price catalog");
      const nextEtag = response.headers.get("etag");
      const data = JSON.stringify({ etag: nextEtag, prices: [...next] });
      if (Buffer.byteLength(data) > MAX_CACHE_BYTES) throw new Error("Price catalog exceeds cache size limit");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, data, { flag: "wx", mode: 0o600 });
        await fs.rename(temp, file);
      } finally {
        await fs.unlink(temp).catch(() => undefined);
      }
      prices = next;
      etag = nextEtag;
    })().finally(() => { updating = undefined; });
    return updating;
  }

  return { read, update };
}
