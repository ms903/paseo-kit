import {
  EMPTY_CATALOG,
  findModelPrice,
  priceTokens,
  type PriceCatalog,
} from "./price-catalog";

/** USD per million tokens: input, output, cache reads. */
type Rate = readonly [number, number, number];
interface Price {
  base: Rate;
  long?: Rate;
  fromDecember2026?: Rate;
  fromJanuary2027?: Rate;
  above100k?: Rate;
}
// Official standard API rates:
// https://aistudio.google.com/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
export const ANTIGRAVITY_PRICES: Record<string, Price> = {
  "gemini-4-carbon": { base: [2, 10, 0.1], fromDecember2026: [4, 20, 0.2] },
  "gemini-4-argon": { base: [2, 10, 0.1], fromDecember2026: [4, 20, 0.2] },
  "gemini-4-hydrogen": { base: [1.5, 7.5, 0.075] },
  "gemini-4-neon": { base: [3, 15, 0.15] },
  "gemini-3.1-pro": { base: [2, 12, 0.2], long: [4, 18, 0.4] },
  "gemini-3-pro": { base: [2, 12, 0.2], long: [4, 18, 0.4] },
  "gemini-3-flash": { base: [0.5, 3, 0.05] },
  "gemini-3.8-flash": {
    base: [0.75, 3.75, 0.075],
    fromJanuary2027: [1.5, 7.5, 0.15],
  },
  "gemini-3.1-flash-lite": { base: [0.25, 1.5, 0.025] },
  "gemini-3.5-flash-lite": { base: [0.3, 2.5, 0.03] },
  "gemini-2.5-pro": { base: [1.25, 10, 0.125], long: [2.5, 15, 0.25] },
  "gemini-2.5-flash": { base: [0.3, 2.5, 0.03] },
  "gemini-2.5-flash-lite": { base: [0.1, 0.4, 0.01] },
  "claude-opus-4": { base: [15, 75, 1.5] },
  "claude-opus-4-1": { base: [15, 75, 1.5] },
  "claude-opus-4-5": { base: [5, 25, 0.5] },
  "claude-opus-4-6": { base: [5, 25, 0.5] },
  "claude-opus-4-7": { base: [5, 25, 0.5] },
  "claude-opus-4-8": { base: [5, 25, 0.5] },
  "claude-opus-5": { base: [5, 25, 0.5] },
  "claude-opus-5-5": { base: [4, 20, 0.2] },
  "claude-sonnet-4": { base: [3, 15, 0.3] },
  "claude-sonnet-4-5": { base: [3, 15, 0.3] },
  "claude-sonnet-4-6": { base: [3, 15, 0.3] },
  "claude-sonnet-5": { base: [2, 10, 0.2] },
  "claude-sonnet-5-5": { base: [2, 10, 0.1] },
  "claude-haiku-5-5": { base: [0.1, 0.5, 0.01], above100k: [0.5, 2.5, 0.05] },
  "claude-haiku-4-5": { base: [1, 5, 0.1] },
  "claude-fable-5": { base: [10, 50, 1] },
  "claude-fable-5-1": { base: [10, 50, 0.25] },
  "claude-fable-5-2": { base: [8, 40, 0.2] },
  "claude-mythos-5": { base: [10, 50, 1] },
  "claude-mythos-5-1": { base: [10, 50, 0.25] },
  "claude-mythos-5-2": { base: [8, 40, 0.2] },
};

export function modelName(
  modelId: string,
  label: string,
  catalog = EMPTY_CATALOG,
): string {
  const id = modelId
    .trim()
    .toLowerCase()
    .replace(/-tiered$/, "")
    .replace(/-(minimal|low|medium|high|xhigh|thinking)$/, "")
    .replace(/-preview(?:-\d{2}-\d{2})?$/, "")
    .replace(/-\d{8}$/, "");
  const gemini =
    /^Gemini\s+(\d+(?:\.\d+)*)\s+(Flash[ -]Lite|[a-z][a-z-]*)\b/i.exec(label);
  const claude =
    /^Claude\s+(Opus|Sonnet|Haiku|Fable|Mythos)\s+(\d+(?:\.\d+)*)\b/i.exec(
      label,
    );
  const named = gemini
    ? `gemini-${gemini[1]}-${gemini[2]!.toLowerCase().replace(/ /g, "-")}`
    : claude
      ? `claude-${claude[1]!.toLowerCase()}-${claude[2]!.replace(/\./g, "-")}`
      : "";
  if (Object.hasOwn(ANTIGRAVITY_PRICES, id) || findModelPrice(catalog, id))
    return id;
  if (named) return named;
  return id || label || "unknown";
}

export const BUILTIN_CONTEXT_BOUNDS = [100_000, 200_000] as const;

export function generationCost(
  model: string,
  input: number,
  output: number,
  cached: number,
  contextSize: number,
  day: string,
  catalog: PriceCatalog = EMPTY_CATALOG,
): number {
  if (model === "gemini-2.5-pro" && day >= "2026-12-01") {
    return generationCost(
      "gemini-3.8-flash",
      input,
      output,
      cached,
      contextSize,
      day,
      catalog,
    );
  }
  const price = Object.hasOwn(ANTIGRAVITY_PRICES, model)
    ? ANTIGRAVITY_PRICES[model]
    : undefined;
  const live = findModelPrice(catalog, model);
  // Keep published dated schedules when recalculating historical requests.
  if (live && !price?.fromDecember2026 && !price?.fromJanuary2027) {
    return priceTokens(
      {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
      },
      live,
      contextSize,
    );
  }
  if (!price) return 0;
  const rates =
    contextSize > 100_000 && price.above100k
      ? price.above100k
      : day >= "2027-01-01" && price.fromJanuary2027
        ? price.fromJanuary2027
        : day >= "2026-12-01" && price.fromDecember2026
          ? price.fromDecember2026
          : contextSize > 200_000 && price.long
            ? price.long
            : price.base;
  return (input * rates[0] + output * rates[1] + cached * rates[2]) / 1_000_000;
}
