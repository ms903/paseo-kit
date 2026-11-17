import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GPU_REFRESH_MS, type GpuUsage } from "../shared/stats";

const execFileAsync = promisify(execFile);
const MAX_GPUS = 64;
const MIB = 1024 * 1024;
const EMPTY_REFRESH_MS = 60_000;
const vendors = new Map([
  ["0x1002", "AMD"],
  ["0x10de", "NVIDIA"],
  ["0x8086", "Intel"],
]);

function parseMetric(text: string | undefined): number | null {
  if (!text?.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function scaled(text: string | undefined, factor: number): number | null {
  const value = parseMetric(text);
  return value === null ? null : value * factor;
}

function pciAddress(value: string): string | undefined {
  // NVIDIA uses an eight-digit domain. Linux sysfs uses four digits.
  return /^(?:[\da-f]{4})?([\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[0-7])$/i.exec(value.trim())?.[1]
    ?.toLowerCase();
}

export function parseNvidiaGpus(output: string): GpuUsage[] {
  const gpus: GpuUsage[] = [];
  for (const line of output.split("\n")) {
    const [index = "", address = "", ...fields] = line.split(",");
    const id = pciAddress(address) ?? (/^\d+$/.test(index.trim()) ? `nvidia-${index.trim()}` : null);
    if (!id || fields.length < 5) continue;
    const [load, used, total, temperature] = fields.splice(-4);
    const name = fields.join(",").trim().replace(/^"|"$/g, "").replaceAll('""', '"');
    gpus.push({
      id,
      name: name || "NVIDIA GPU",
      utilizationPercent: parseMetric(load),
      vramUsedBytes: scaled(used, MIB),
      vramTotalBytes: scaled(total, MIB),
      temperatureCelsius: parseMetric(temperature),
    });
    if (gpus.length === MAX_GPUS) break;
  }
  return gpus;
}

async function readGpuCommand(command: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      signal,
      timeout: 2_500,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function readProperty(device: string, property: string, signal?: AbortSignal): Promise<string> {
  return readFile(path.join(device, property), { encoding: "utf8", signal })
    .then((value) => value.trim(), () => "");
}

async function readTemperature(device: string, signal?: AbortSignal): Promise<number | null> {
  const monitors = await readdir(path.join(device, "hwmon")).catch(() => []);
  for (const monitor of monitors) {
    if (!/^hwmon\d+$/.test(monitor)) continue;
    const value = await readProperty(device, `hwmon/${monitor}/temp1_input`, signal);
    const temperature = scaled(value, 0.001);
    if (temperature !== null) return temperature;
  }
  return null;
}

export async function readDrmGpus(directory = "/sys/class/drm", signal?: AbortSignal): Promise<GpuUsage[]> {
  const entries = await readdir(directory).catch(() => []);
  const cards = entries.filter((name) => /^card\d+$/.test(name)).sort().slice(0, MAX_GPUS);
  const gpus: GpuUsage[] = [];
  for (const card of cards) {
    if (signal?.aborted) break;
    const device = path.join(directory, card, "device");
    const vendor = vendors.get(await readProperty(device, "vendor", signal));
    if (!vendor) continue;
    const [sysPath, product, chip, load, used, total, temperature] = await Promise.all([
      realpath(device).catch(() => ""),
      readProperty(device, "product_name", signal),
      readProperty(device, "device", signal),
      readProperty(device, "gpu_busy_percent", signal),
      readProperty(device, "mem_info_vram_used", signal),
      readProperty(device, "mem_info_vram_total", signal),
      readTemperature(device, signal),
    ]);
    gpus.push({
      id: pciAddress(path.basename(sysPath)) ?? card,
      name: product || `${vendor} GPU${chip ? ` (${chip})` : ""}`,
      utilizationPercent: parseMetric(load),
      vramUsedBytes: parseMetric(used),
      vramTotalBytes: parseMetric(total),
      temperatureCelsius: temperature,
    });
  }
  return gpus;
}

function createGpuCollector() {
  let nextNvidiaReadAt = 0;

  const readNvidia = async (signal: AbortSignal) => {
    if (Date.now() < nextNvidiaReadAt) return [];
    const output = await readGpuCommand("nvidia-smi", [
      "--query-gpu=index,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ], signal);
    const gpus = parseNvidiaGpus(output);
    if (!gpus.length) nextNvidiaReadAt = Date.now() + EMPTY_REFRESH_MS;
    return gpus;
  };

  return async (signal: AbortSignal): Promise<GpuUsage[]> => {
    if (process.platform === "darwin") {
      const output = await readGpuCommand("/usr/sbin/ioreg", ["-r", "-c", "AGXAccelerator", "-d", "1"], signal);
      const utilizationPercent = parseMetric(/"Device Utilization %"\s*=\s*(\d+)/.exec(output)?.[1]);
      if (utilizationPercent === null) return [];
      return [{
        id: "apple",
        name: "Apple GPU",
        utilizationPercent,
        vramUsedBytes: null,
        vramTotalBytes: null,
        temperatureCelsius: null,
      }];
    }

    if (process.platform === "win32") return readNvidia(signal);
    if (process.platform !== "linux") return [];
    const [nvidia, drm] = await Promise.all([readNvidia(signal), readDrmGpus(undefined, signal)]);
    const nvidiaIds = new Set(nvidia.map((gpu) => gpu.id));
    return [...nvidia, ...drm.filter((gpu) => !nvidiaIds.has(gpu.id))];
  };
}

/** Only the host details RPC starts a sample. Calls share a snapshot and a single in-flight read. */
export function createGpuSampler(collect = createGpuCollector()) {
  const lifetime = new AbortController();
  let saved: GpuUsage[] = [];
  let expiresAt = 0;
  let pending: Promise<GpuUsage[]> | null = null;

  return {
    read(): Promise<GpuUsage[]> {
      if (lifetime.signal.aborted) return Promise.resolve([]);
      if (Date.now() < expiresAt) return Promise.resolve(saved);
      pending ??= collect(lifetime.signal).then((gpus) => {
        saved = gpus;
        expiresAt = Date.now() + (gpus.length ? GPU_REFRESH_MS : EMPTY_REFRESH_MS);
        return gpus;
      }).finally(() => {
        pending = null;
      });
      return pending;
    },
    stop() {
      lifetime.abort();
    },
  };
}
