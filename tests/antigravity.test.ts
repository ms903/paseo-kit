import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  antigravityReport,
  createAntigravityReport,
  readConversations,
  mergeAntigravity,
} from "../plugins/ccusage-stats/server/antigravity";
import {
  modelName,
  generationCost,
} from "../plugins/ccusage-stats/server/antigravity-prices";
import { parsePriceCatalog } from "../plugins/ccusage-stats/server/price-catalog";
import { createUsageStore } from "../plugins/ccusage-stats/server/usage-store";
import { createSessionMatcher } from "../plugins/ccusage-stats/server/sessions";
import { EMPTY_USAGE } from "../plugins/ccusage-stats/shared/usage";
function vi(value: number): Buffer {
  const out: number[] = [];
  let v = BigInt(value);
  do {
    let b = Number(v & 127n);
    v >>= 7n;
    if (v) b |= 128;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
function num(n: number, v: number) {
  return Buffer.concat([vi(n * 8), vi(v)]);
}
function msg(n: number, v: Buffer | string) {
  const b = Buffer.from(v);
  return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]);
}
const seconds = Date.parse("2026-11-15T23:30:00Z") / 1000;

test("matches Antigravity persistence to the conversation row for its composer pill", async () => {
  const conversationId = "b966b16a-caf4-448a-bb24-0e34956022b0";
  const persisted = { version: 1, data: { conversationId } };
  const agent = { provider: "antigravity", sessionId: `plugin:${JSON.stringify(persisted)}` };
  const session = {
    id: conversationId,
    agent: "antigravity",
    usage: { ...EMPTY_USAGE, inputTokens: 300, totalTokens: 300, cost: 0.00045 },
    models: [],
    lastActivity: null,
  };
  const codex = { ...session, agent: "codex", id: "2026/11/15/rollout-2026-11-15-thread" };
  const other = { ...session, agent: "claude" };
  const persistence = new Map([
    ["with-metadata", { ...agent, metadata: { pluginProviderPersistence: persisted } }],
    ["encoded-only", agent],
    ["native", { ...agent, nativeHandle: conversationId }],
    ["malformed", { ...agent, sessionId: "plugin:{" }],
    ["codex", { provider: "codex", sessionId: "thread" }],
  ]);
  const paseo = {
    agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { persistence: persistence.get(id) } }) }) },
  } as Parameters<ReturnType<typeof createSessionMatcher>["resolve"]>[1];
  const matcher = createSessionMatcher({ sessions: async () => [other, codex, session] });

  const { sessions } = await matcher.resolve({ agentIds: [...persistence.keys()] }, paseo);
  for (const [index, agentId] of ["with-metadata", "encoded-only", "native"].entries()) {
    assert.deepEqual(sessions[index], { status: "matched", agentId, providerSessionId: conversationId, session });
  }
  assert.deepEqual(sessions[3], { status: "unknown", agentId: "malformed" });
  assert.deepEqual(sessions[4], { status: "matched", agentId: "codex", providerSessionId: "thread", session: codex });
});

function generation(
  input = 200,
  output = 10,
  cache = 50,
  ts = seconds,
  id = "gemini-pro-default",
  label = "Gemini 3.1 Pro (High)",
) {
  return msg(
    1,
    Buffer.concat([
      msg(
        4,
        Buffer.concat([
          num(1, 100),
          num(2, input),
          num(3, output),
          num(5, cache),
        ]),
      ),
      ...(ts ? [msg(9, msg(4, num(1, ts)))] : []),
      msg(19, id),
      msg(21, label),
    ]),
  );
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-ag-"));
  const dir = path.join(root, "antigravity-cli", "conversations");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "session-one.db");
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB);",
  );
  return {
    root,
    file,
    db,
    insert: (idx: number, b: Buffer) =>
      db.prepare("INSERT INTO gen_metadata VALUES(?,?)").run(idx, b),
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("reads live WAL without changing source files and refreshes after an append", async () => {
  const f = await fixture();
  try {
    f.insert(1, generation());
    const before = await stat(f.file);
    const walBefore = await stat(f.file + "-wal");
    const report = await antigravityReport("Asia/Tokyo", undefined, f.root);
    assert.equal(report.daily[0].period, "2026-11-16");
    assert.equal(report.weekly[0].period, "2026-11-16");
    assert.equal(report.session[0].inputTokens, 300);
    assert.equal(report.session[0].cacheReadTokens, 50);
    assert.equal(report.session[0].totalTokens, 360);
    assert.ok(Math.abs(report.daily[0].totalCost - 0.00073) < 1e-10);
    assert.equal((await stat(f.file)).mtimeMs, before.mtimeMs);
    assert.equal((await stat(f.file + "-wal")).mtimeMs, walBefore.mtimeMs);
    f.insert(2, generation());
    assert.equal(
      (await antigravityReport("Asia/Tokyo", undefined, f.root)).session[0]
        .totalTokens,
      720,
    );
    assert.equal(
      (await antigravityReport("UTC", undefined, f.root)).daily[0].period,
      "2026-11-15",
    );
  } finally {
    await f.cleanup();
  }
});

test("a restored Antigravity index opens only databases whose contents or WAL changed", async () => {
  const f = await fixture();
  const zone = "Asia/Hong_Kong";
  const cache = path.join(f.root, "cache");
  const reads: string[][] = [];
  const openReport = () => createAntigravityReport(createUsageStore(zone, cache), (...args) => {
    reads.push(args[0]);
    return readConversations(...args);
  });
  try {
    f.insert(1, generation());
    const first = await openReport()(zone, undefined, f.root);
    assert.deepEqual(reads, [[f.file]]);
    const restarted = openReport();
    const warm = await restarted(zone, undefined, f.root);
    assert.deepEqual(warm, first);
    assert.equal(await restarted(zone, undefined, f.root), warm);
    assert.equal(reads.length, 1);
    f.insert(2, generation());
    const updated = await restarted(zone, undefined, f.root);
    assert.equal(updated.session[0].totalTokens, 720);
    assert.deepEqual(reads, [[f.file], [f.file]]);
  } finally {
    await f.cleanup();
  }
});

test("decodes step timestamps, skips corrupt and oversized protobuf rows, prices context tiers per call", async () => {
  const f = await fixture();
  try {
    f.insert(1, generation(200, 10, 50, 0));
    f.db
      .prepare("INSERT INTO steps VALUES(?,?)")
      .run(1, msg(1, num(1, seconds)));
    f.insert(2, generation(200001, 10, 0));
    f.insert(3, Buffer.from([0x80]));
    f.insert(4, Buffer.alloc(1048577));
    f.insert(5, generation(1, 1, 0, 0));
    const report = await antigravityReport("UTC", undefined, f.root);
    assert.equal(report.daily[0].totalTokens, 200471);
    assert.ok(
      Math.abs(
        report.daily[0].totalCost -
          (0.00073 + (200101 * 4) / 1e6 + (10 * 18) / 1e6),
      ) < 1e-10,
    );
    assert.equal(
      (await readConversations([f.file], "UTC"))[0].buckets.length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});

test("prices Hydrogen for the base ID, Extra thinking, and the model label", async () => {
  const f = await fixture();
  try {
    const models = [
      { id: "gemini-4-hydrogen", label: "" },
      { id: "gemini-4-hydrogen-xhigh", label: "" },
      { id: "gemini-flash-default", label: "Gemini 4 Hydrogen (Extra)" },
    ];
    for (const [index, { id, label }] of models.entries()) {
      f.insert(
        index + 1,
        generation(99_900, 20_000, 50_000, seconds, id, label),
      );
    }

    const report = await antigravityReport("UTC", undefined, f.root);
    assert.equal(report.session[0].totalTokens, 510_000);
    assert.deepEqual(
      report.session[0].modelBreakdowns.map((model) => model.modelName),
      ["gemini-4-hydrogen"],
    );
    // 300k input, 60k output, and 150k cached tokens at the Standard rates.
    for (const rows of [
      report.daily,
      report.weekly,
      report.monthly,
      report.session,
    ]) {
      assert.ok(Math.abs(rows[0].totalCost - 0.91125) < 1e-10);
    }
  } finally {
    await f.cleanup();
  }
});

test("counts new Neon turns in an existing conversation on their own Hong Kong date", async () => {
  const f = await fixture();
  const beforeMidnight = Date.parse("2026-11-19T15:45:00Z") / 1000;
  const afterMidnight = Date.parse("2026-11-19T16:15:00Z") / 1000;
  try {
    f.insert(1, generation(99_900, 20_000, 50_000, beforeMidnight, "gemini-4-neon", ""));
    const before = await antigravityReport("Asia/Hong_Kong", undefined, f.root);
    assert.deepEqual(before.daily.map((row) => row.period), ["2026-11-19"]);

    const call = generation(99_900, 20_000, 50_000, 0, "gemini-4-neon-xhigh", "Gemini 4 Neon (Extra)");
    f.insert(2, Buffer.concat([call, num(2, 41)]));
    f.insert(3, Buffer.concat([call, msg(2, Buffer.concat([vi(50), vi(52)]))]));
    const step = f.db.prepare("INSERT INTO steps VALUES(?,?)");
    step.run(2, msg(1, num(1, beforeMidnight)));
    step.run(41, Buffer.concat([msg(1, num(1, beforeMidnight)), msg(8, num(1, afterMidnight))]));
    step.run(52, msg(8, num(1, afterMidnight + 60)));

    const after = await antigravityReport("Asia/Hong_Kong", undefined, f.root);
    const today = after.daily.find((row) => row.period === "2026-11-20");
    assert.equal(after.daily.find((row) => row.period === "2026-11-19")?.totalTokens, 170_000);
    assert.equal(today?.totalTokens, 340_000);
    assert.ok(today && Math.abs(today.totalCost - 1.215) < 1e-10);
    assert.deepEqual(today?.modelBreakdowns.map((model) => model.modelName), ["gemini-4-neon"]);
    assert.equal(after.session[0].period, before.session[0].period);
    assert.equal(after.session[0].totalTokens, 510_000);
    assert.equal(after.session[0].metadata?.lastActivity, "2026-11-19T16:16:00.000Z");
  } finally {
    await f.cleanup();
  }
});

test("prices a new Antigravity model when the catalog publishes it", async () => {
  const f = await fixture();
  try {
    const id = "gemini-9-fixture";
    f.insert(1, generation(99_900, 1_000, 30_000, seconds, id, ""));
    assert.equal((await antigravityReport("UTC", undefined, f.root)).daily[0].totalCost, 0);
    const catalog = parsePriceCatalog({
      google: { models: { [id]: { cost: {
        input: 2, output: 4, cache_read: 0.2,
        tiers: [{ input: 3, output: 7, cache_read: 0.3, tier: { type: "context", size: 128_000 } }],
      } } } },
    });
    const updated = await antigravityReport("UTC", undefined, f.root, catalog);
    assert.equal(updated.session[0].totalTokens, 131_000);
    assert.ok(Math.abs(updated.daily[0].totalCost - 0.316) < 1e-10);
  } finally {
    await f.cleanup();
  }
});

test("deduplicates mirrored surfaces, excludes backups and replaces native ccusage Antigravity totals", async () => {
  const f = await fixture();
  try {
    f.insert(1, generation());
    const backup = path.join(f.root, "antigravity-backup", "conversations");
    await mkdir(backup, { recursive: true });
    const backupDb = new DatabaseSync(path.join(backup, "extra.db"));
    backupDb.exec("CREATE TABLE gen_metadata(idx INTEGER, data BLOB)");
    backupDb
      .prepare("INSERT INTO gen_metadata VALUES(?,?)")
      .run(1, generation(999999));
    backupDb.close();
    const app = path.join(f.root, "antigravity", "conversations");
    await mkdir(app, { recursive: true });
    const mirror = new DatabaseSync(path.join(app, "session-one.db"));
    mirror.exec("CREATE TABLE gen_metadata(idx INTEGER, data BLOB)");
    mirror.prepare("INSERT INTO gen_metadata VALUES(?,?)").run(1, generation());
    mirror.close();
    const ag = await antigravityReport("UTC", undefined, f.root);
    assert.equal(ag.session.length, 1);
    const native = { ...ag.daily[0], agent: "antigravity", totalTokens: 999 };
    const claude = { ...ag.daily[0], agent: "claude" };
    const raw = {
      daily: [{ ...ag.daily[0], agents: [native, claude] }],
      weekly: [],
      monthly: [],
      session: [native],
    };
    const merged = mergeAntigravity(raw, ag);
    assert.equal(merged.daily[0].totalTokens, 720);
    assert.equal(merged.daily[0].agents?.length, 2);
    assert.equal(merged.session.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("resolves served model labels and official price boundaries", () => {
  assert.equal(
    modelName("gemini-pro-default", "Gemini 3.1 Pro (High)"),
    "gemini-3.1-pro",
  );
  assert.equal(
    modelName("internal-model-a", "Claude Opus 4.6 (Thinking)"),
    "claude-opus-4-6",
  );
  assert.equal(
    modelName("claude-sonnet-4-5-20250929", ""),
    "claude-sonnet-4-5",
  );
  assert.equal(
    generationCost("claude-opus-4-6", 1e6, 1e6, 1e6, 0, "2026-11-17"),
    30.5,
  );
  assert.equal(
    generationCost("gemini-4-carbon", 1e6, 1e6, 1e6, 0, "2026-11-30"),
    12.1,
  );
  assert.equal(
    generationCost("gemini-4-carbon", 1e6, 1e6, 1e6, 0, "2026-12-01"),
    24.2,
  );
  assert.equal(
    generationCost("gemini-3.8-flash", 1e6, 1e6, 1e6, 0, "2026-12-31"),
    4.575,
  );
  assert.equal(
    generationCost("gemini-3.8-flash", 1e6, 1e6, 1e6, 0, "2027-01-01"),
    9.15,
  );
  assert.equal(
    generationCost("claude-haiku-5-5", 100001, 100, 0, 100001, "2026-11-17"),
    0.0502505,
  );
});
