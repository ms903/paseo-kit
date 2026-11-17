import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  RawReport,
  RawRow,
} from "../plugins/ccusage-stats/server/ccusage";
import { createReportPricer } from "../plugins/ccusage-stats/server/codex-prices";
import {
  createPriceCatalog,
  EMPTY_CATALOG,
  findModelPrice,
  parsePriceCatalog,
} from "../plugins/ccusage-stats/server/price-catalog";

const sol = "gpt-6.2-sol";
const astra = "gpt-6.2-astra";
function pricingPayload(input: number) {
  return {
    openai: {
      models: {
        [sol]: {
          cost: {
            input,
            output: 10,
            cache_read: 0.1,
            cache_write: 2.5,
            tiers: [
              {
                input: 2 * input,
                output: 15,
                cache_read: 0.2,
                cache_write: 5,
                tier: { type: "context", size: 272_000 },
              },
            ],
          },
        },
      },
    },
  };
}

test("only updates prices on request and keeps the last saved catalog across restarts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-price-catalog-"));
  const file = path.join(root, "prices.json");
  const lifetime = new AbortController();
  const requests: RequestInit[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://models.dev/api.json");
    requests.push(init ?? {});
    if (requests.length === 2) return new Response(null, { status: 304 });
    if (requests.length === 3) return new Response(null, { status: 503 });
    const first = requests.length === 1;
    return Response.json(pricingPayload(first ? 2 : 3), {
      headers: { etag: first ? '"one"' : '"two"' },
    });
  };
  try {
    const catalog = createPriceCatalog(lifetime.signal, file, request);
    assert.equal((await catalog.read()).size, 0);
    assert.equal(requests.length, 0);
    await Promise.all([catalog.update(), catalog.update()]);
    assert.equal(requests.length, 1);
    assert.equal(findModelPrice(await catalog.read(), sol)?.standard.input, 2);

    const restarted = createPriceCatalog(lifetime.signal, file, request);
    assert.equal(findModelPrice(await restarted.read(), sol)?.standard.input, 2);
    assert.equal(requests.length, 1);
    await restarted.update();
    assert.equal(new Headers(requests[1].headers).get("if-none-match"), '"one"');
    await assert.rejects(restarted.update(), /503/);
    assert.equal(findModelPrice(await restarted.read(), sol)?.standard.input, 2);
    assert.equal(requests.length, 3);
    await restarted.update();
    assert.equal(findModelPrice(await restarted.read(), sol)?.standard.input, 3);
    assert.equal(requests.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sampleReport(session: string): RawReport {
  const modelBreakdowns = [
    {
      modelName: sol,
      inputTokens: 480_000,
      outputTokens: 1_300,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 0,
      cost: 0,
      missingPricing: true,
    },
    {
      modelName: astra,
      inputTokens: 180_000,
      outputTokens: 500,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 20_000,
      cost: 0,
      missingPricing: true,
    },
    {
      modelName: "gpt-6.1-sol",
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: 0.42,
    },
  ];
  const row = (period: string): RawRow => ({
    period,
    agent: "codex",
    totalTokens: 881_930,
    totalCost: 0.42,
    inputTokens: 660_100,
    outputTokens: 1_830,
    cacheReadTokens: 200_000,
    cacheCreationTokens: 20_000,
    modelBreakdowns: structuredClone(modelBreakdowns),
  });
  return {
    daily: [row("2026-11-17")],
    weekly: [row("2026-11-16")],
    monthly: [row("2026-11")],
    session: [row(session)],
  };
}

test("prices GPT-6.2 per request, including cached tokens, long context and recorded Fast mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-codex-prices-"));
  const session = "2026/11/17/rollout-2026-11-17T12-00-00-test";
  const file = path.join(root, "sessions", `${session}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const at = "2026-11-17T12:00:00Z";
  const context = (model: string) => ({
    timestamp: at,
    type: "turn_context",
    payload: { model },
  });
  const usage = (input: number, cached: number, output: number, write = 0) => ({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          cache_write_input_tokens: write,
        },
      },
    },
  });
  try {
    const compacted = (id: string, usageRecord: ReturnType<typeof usage>) => ({
      timestamp: at, type: "token_usage_record", payload: { response_id: id, usage: usageRecord.payload.info.last_token_usage },
    });
    const marker = (id: string) => ({ timestamp: at, type: "compacted", payload: { compaction_response_id: id } });
    const short = usage(220_000, 40_000, 500);
    await writeFile(
      file,
      [
        context(sol),
        compacted("local", short), short, marker("local"),
        compacted("remote", usage(360_000, 60_000, 800)), marker("remote"),
        context(astra),
        {
          timestamp: at,
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { service_tier: "priority" },
          },
        },
        usage(300_000, 100_000, 500, 20_000),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const applyPrices = createReportPricer([root]);
    const signal = new AbortController().signal;
    const report = sampleReport(session);
    await applyPrices(report, "UTC", EMPTY_CATALOG, signal);
    for (const rows of [
      report.daily,
      report.weekly,
      report.monthly,
      report.session,
    ]) {
      const row = rows[0];
      // Sol = (0.36 + 0.004 + 0.005) + (1.2 + 0.012 + 0.012).
      assert.ok(Math.abs(row.modelBreakdowns[0].cost - 1.593) < 1e-10);
      // Astra = 2 × (2.88 + 0.08 + 0.4 + 0.03).
      assert.ok(Math.abs(row.modelBreakdowns[1].cost - 6.78) < 1e-10);
      assert.equal(row.modelBreakdowns[2].cost, 0.42);
      assert.ok(Math.abs(row.totalCost - 8.793) < 1e-10);
    }
    const refreshed = sampleReport(session);
    await applyPrices(
      refreshed,
      "UTC",
      parsePriceCatalog({ ...pricingPayload(3), openai: { models: {
        ...pricingPayload(3).openai.models,
        "gpt-6.1-sol": { cost: { input: 5, output: 10 } },
      } } }),
      signal,
    );
    assert.ok(
      Math.abs(refreshed.session[0].modelBreakdowns[0].cost - 2.373) < 1e-10,
    );
    assert.ok(Math.abs(refreshed.session[0].modelBreakdowns[2].cost - 0.0008) < 1e-10);
    assert.equal(
      refreshed.session[0].totalTokens,
      report.session[0].totalTokens,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
