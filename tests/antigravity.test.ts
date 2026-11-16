import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  antigravityReport,
  readConversations,
  mergeAntigravity,
} from "../plugins/ccusage-stats/server/antigravity";
import {
  modelName,
  generationCost,
} from "../plugins/ccusage-stats/server/antigravity-prices";
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
    generationCost("claude-opus-4-6", 1e6, 1e6, 1e6, false, "2026-11-17"),
    30.5,
  );
  assert.equal(
    generationCost("gemini-4-carbon", 1e6, 1e6, 1e6, false, "2026-11-30"),
    12.1,
  );
  assert.equal(
    generationCost("gemini-4-carbon", 1e6, 1e6, 1e6, false, "2026-12-01"),
    24.2,
  );
  assert.equal(
    generationCost("gemini-3.8-flash", 1e6, 1e6, 1e6, false, "2026-12-31"),
    4.575,
  );
  assert.equal(
    generationCost("gemini-3.8-flash", 1e6, 1e6, 1e6, false, "2027-01-01"),
    9.15,
  );
  assert.equal(
    generationCost(
      "claude-haiku-5-5",
      100001,
      100,
      0,
      false,
      "2026-11-17",
      true,
    ),
    0.0502505,
  );
});
