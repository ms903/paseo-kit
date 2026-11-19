import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGpuSampler, parseNvidiaGpus, readDrmGpus } from "../plugins/host-monitor/server/gpus";
import { startSampler } from "../plugins/host-monitor/server/sampler";
import { gpuSummary } from "../plugins/host-monitor/client/format";

const MIB = 1024 * 1024;

test("the footer hides absent GPUs and distinguishes idle devices from missing utilization", () => {
  const gpus = parseNvidiaGpus([
    "0, 0000:01:00.0, First, 0, 0, 8192, 40",
    "1, 0000:02:00.0, Second, 81, 4096, 8192, 61",
    "2, 0000:03:00.0, Third, N/A, 0, 8192, N/A",
  ].join("\n"));
  assert.equal(gpuSummary(undefined), null);
  assert.equal(gpuSummary([]), null);
  assert.equal(gpuSummary([gpus[0]])?.text, "0%");
  assert.deepEqual(gpuSummary(gpus), { percent: 81, text: "×3 81%", wide: true, description: "3 GPUs, peak utilization 81%" });
  assert.deepEqual(gpuSummary([gpus[2]]), { text: "×1", wide: false, description: "1 GPU" });
});

test("reads separate NVIDIA devices and preserves counters the driver omits", () => {
  const gpus = parseNvidiaGpus([
    '0, 00000000:01:00.0, "NVIDIA GPU, fixture", 35, 1024, 8192, 68',
    "1, [N/A], NVIDIA A100, [Not Supported], 0, 40960, N/A",
    "invalid line",
  ].join("\r\n"));
  assert.deepEqual(gpus, [
    { id: "0000:01:00.0", deviceLabel: "0", name: "NVIDIA GPU, fixture", utilizationPercent: 35,
      vramUsedBytes: 1024 * MIB, vramTotalBytes: 8192 * MIB, temperatureCelsius: 68 },
    { id: "nvidia-1", deviceLabel: "1", name: "NVIDIA A100", utilizationPercent: null,
      vramUsedBytes: 0, vramTotalBytes: 40960 * MIB, temperatureCelsius: null },
  ]);
});

test("reads AMD sysfs counters as bytes and ignores display connectors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-drm-"));
  try {
    const device = path.join(root, "card0", "device");
    await mkdir(path.join(device, "hwmon", "hwmon7"), { recursive: true });
    await mkdir(path.join(root, "card0-DP-1"));
    const values = {
      vendor: "0x1002",
      product_name: "AMD Radeon fixture",
      gpu_busy_percent: "48",
      mem_info_vram_used: "1073741824",
      mem_info_vram_total: "8589934592",
      "hwmon/hwmon7/temp1_input": "51250",
    };
    await Promise.all(Object.entries(values).map(([name, value]) => writeFile(path.join(device, name), `${value}\n`)));
    assert.deepEqual(await readDrmGpus(root), [
      { id: "card0", deviceLabel: "card0", name: "AMD Radeon fixture", utilizationPercent: 48,
        vramUsedBytes: 1024 * MIB, vramTotalBytes: 8192 * MIB, temperatureCelsius: 51.25 },
    ]);
    assert.deepEqual(await readDrmGpus(root, undefined, new Set(["card0"])), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all eight GPUs retain driver indices and share one probe across views", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T00:00:00Z") });
  const indices = [0, 2, 5, 7, 1, 3, 4, 6];
  const output = indices.map((i) =>
    `${i}, 00000000:${10 + i}:00.0, NVIDIA A100, ${i === 7 ? 96 : 0}, ${i * 1024}, 81920, ${42 + i}`,
  ).join("\n");
  let probes = 0;
  const sampler = createGpuSampler(async () => { probes++; return parseNvidiaGpus(output); });
  try {
    const [gpus, popover, detail] = await Promise.all([sampler.read(), sampler.read(), sampler.read()]);
    assert.equal(gpus.length, 8);
    assert.equal(new Set(gpus.map((gpu) => gpu.id)).size, 8);
    assert.deepEqual(gpus.map((gpu) => gpu.deviceLabel), ["0", "1", "2", "3", "4", "5", "6", "7"]);
    assert.equal(gpus[7].vramUsedBytes, 7 * 1024 * MIB);
    assert.equal(gpuSummary(gpus)?.text, "×8 96%");
    assert.equal(popover, gpus);
    assert.equal(detail, gpus);
    t.mock.timers.tick(9_999);
    await sampler.read();
    assert.equal(probes, 1);
    t.mock.timers.tick(1);
    await sampler.read();
    assert.equal(probes, 2);
  } finally {
    sampler.stop();
  }
});

test("shares one GPU probe and backs off without readings", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-11-18T00:00:00Z") });
  let probes = 0;
  let complete: () => void = () => {};
  const sampler = createGpuSampler(() => {
    probes += 1;
    return new Promise((resolve) => { complete = () => resolve([]); });
  });
  try {
    t.mock.timers.tick(60_000);
    assert.equal(probes, 0);
    const concurrent = Array.from({ length: 32 }, () => sampler.read());
    t.mock.timers.tick(60_000);
    concurrent.push(sampler.read());
    assert.equal(probes, 1);
    complete();
    await Promise.all(concurrent);
    t.mock.timers.tick(59_999);
    assert.deepEqual(await sampler.read(), []);
    assert.equal(probes, 1);
    t.mock.timers.tick(1);
    const refreshed = sampler.read();
    assert.equal(probes, 2);
    complete();
    await refreshed;
  } finally {
    sampler.stop();
  }
});

test("samples on demand, coalesces bursts and bounds history", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-11-18T00:00:00Z") });
  const sampler = startSampler();
  try {
    t.mock.timers.tick(60_000);
    const responses = await Promise.all(Array.from({ length: 32 }, () => sampler.read()));
    assert.ok(responses.every((response) => response.history.length === 1));
    t.mock.timers.tick(1_999);
    assert.equal((await sampler.read()).history.length, 1);
    t.mock.timers.tick(1);
    assert.equal((await sampler.read()).history.length, 2);
    for (let i = 0; i < 95; i += 1) {
      t.mock.timers.tick(2_000);
      await sampler.read();
    }
    assert.equal((await sampler.read()).history.length, 90);
    t.mock.timers.tick(60_000);
    assert.equal((await sampler.read()).history.length, 1);
  } finally {
    sampler.stop();
  }
});
