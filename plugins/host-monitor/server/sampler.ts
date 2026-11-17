import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import type { hostStatsRpc } from "../shared/stats";
import type { DiskUsage, HostSample, MemoryPressure, MemoryUsage } from "../shared/stats";

const execFileAsync = promisify(execFile);

const SAMPLE_INTERVAL_MS = 2000;
const SAMPLE_GAP_MS = 10_000;
// Disk usage moves slowly; there is no point in asking the kernel every two seconds.
const DISK_INTERVAL_MS = 30_000;
const MAC_MEMORY_INTERVAL_MS = 10_000;
const HISTORY_LENGTH = 90;
// Virtual interfaces mirror traffic already counted on the physical one.
const IGNORED_INTERFACE = /^(lo|veth|docker|br-|virbr)/;
// Read-only images (snap packages, CDs) are always full and are not space anyone can run out of.
const IGNORED_DISK_FS = new Set(["squashfs", "iso9660", "udf", "erofs"]);
// A stuck macOS tool must not hold up the sample; the previous reading is kept instead.
const MAC_COMMAND_TIMEOUT_MS = 1500;
// kern.memorystatus_vm_pressure_level, as defined by the kernel's kVMPressure* constants.
const MAC_PRESSURE_LEVELS: Record<string, MemoryPressure> = { "1": "normal", "2": "warning", "4": "critical" };

interface CpuTimes {
  idle: number;
  total: number;
}

interface NetworkTotals {
  rx: number;
  tx: number;
}

/**
 * Linux: the aggregate line of /proc/stat. iowait counts as idle; steal counts as busy, since on a
 * VPS it is CPU time the guest wanted but the hypervisor gave elsewhere. os.cpus() omits both.
 */
function readProcCpuTimes(): CpuTimes | null {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n", 1)[0] ?? "";
    if (!line.startsWith("cpu ")) return null;
    // user nice system idle iowait irq softirq steal; guest time is already inside user and nice.
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number);
    return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
  } catch {
    return null;
  }
}

function readCpuTimes(): CpuTimes {
  const proc = readProcCpuTimes();
  if (proc) return proc;
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

/** Memory everywhere but macOS: Linux counts the page cache as free, other systems use os.freemem. */
function readMemory(): MemoryUsage {
  const totalBytes = os.totalmem();
  const usage = (usedBytes: number): MemoryUsage => ({
    totalBytes,
    usedBytes,
    cachedBytes: null,
    pressure: null,
  });
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return usage(totalBytes - Number(match[1]) * 1024);
  } catch {
    // Not Linux: fall back to os.freemem below.
  }
  return usage(totalBytes - os.freemem());
}

/** `vm_stat` output as page counts by label, e.g. "Pages wired down", plus the page size. */
export function parseVmStat(output: string): { pageSize: number; pages: Map<string, number> } | null {
  const pageSize = /page size of (\d+) bytes/.exec(output);
  if (!pageSize) return null;
  const pages = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?$/.exec(line.trim());
    if (match) pages.set(match[1]!, Number(match[2]));
  }
  return { pageSize: Number(pageSize[1]), pages };
}

/**
 * Activity Monitor's accounting: used is app memory (anonymous pages that are not purgeable) plus
 * wired memory plus what the compressor occupies; cached files (file-backed and purgeable pages)
 * are dropped at once when an app needs room, so they count as neither used nor free. os.freemem
 * counts only pages that hold nothing at all, which makes a Mac with a large cache look full.
 */
export function macMemoryFromVmStat(output: string, totalBytes: number): Omit<MemoryUsage, "pressure"> | null {
  const parsed = parseVmStat(output);
  if (!parsed) return null;
  const { pageSize, pages } = parsed;
  const anonymous = pages.get("Anonymous pages");
  const fileBacked = pages.get("File-backed pages");
  const wired = pages.get("Pages wired down");
  const compressor = pages.get("Pages occupied by compressor");
  if (anonymous === undefined || fileBacked === undefined || wired === undefined || compressor === undefined) {
    return null;
  }
  const purgeable = pages.get("Pages purgeable") ?? 0;
  const clamp = (bytes: number) => Math.min(Math.max(bytes, 0), totalBytes);
  return {
    totalBytes,
    usedBytes: clamp((Math.max(anonymous - purgeable, 0) + wired + compressor) * pageSize),
    cachedBytes: clamp((fileBacked + purgeable) * pageSize),
  };
}

async function readMacPressure(signal: AbortSignal): Promise<MemoryPressure | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      { signal, timeout: MAC_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    return MAC_PRESSURE_LEVELS[stdout.trim()] ?? null;
  } catch {
    return null;
  }
}

/** macOS: page counts from vm_stat and the pressure level from sysctl; null if vm_stat fails. */
async function readMacMemory(signal: AbortSignal): Promise<MemoryUsage | null> {
  const totalBytes = os.totalmem();
  const [vmStat, pressure] = await Promise.all([
    execFileAsync("/usr/bin/vm_stat", [], { signal, timeout: MAC_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 }).then(
      ({ stdout }) => stdout,
      () => null,
    ),
    readMacPressure(signal),
  ]);
  const memory = vmStat === null ? null : macMemoryFromVmStat(vmStat, totalBytes);
  return memory ? { ...memory, pressure } : null;
}

function readNetworkTotals(): NetworkTotals | null {
  let raw: string;
  try {
    raw = readFileSync("/proc/net/dev", "utf8");
  } catch {
    return null;
  }
  let rx = 0;
  let tx = 0;
  for (const line of raw.split("\n").slice(2)) {
    const [name, counters] = line.split(":");
    if (!name || !counters || IGNORED_INTERFACE.test(name.trim())) continue;
    const fields = counters.trim().split(/\s+/).map(Number);
    rx += fields[0] ?? 0;
    tx += fields[8] ?? 0;
  }
  return { rx, tx };
}

interface Mount {
  device: string;
  mount: string;
  fsType: string;
}

/** /proc/mounts writes spaces and other awkward characters as octal escapes, e.g. "\040". */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Linux: filesystems backed by a block device, one entry per device. Pseudo and memory-backed
 * filesystems are not disks, and network mounts are skipped because statfs on a dead server can
 * hang. A device mounted more than once (bind mounts, btrfs subvolumes) is counted once, under
 * its shortest mount point. Elsewhere, or when nothing qualifies (a container on overlayfs), the
 * root filesystem alone.
 */
function readLocalMounts(): Mount[] {
  let raw = "";
  try {
    raw = readFileSync("/proc/mounts", "utf8");
  } catch {
    // Not Linux: fall back to the root filesystem below.
  }
  const byDevice = new Map<string, Mount>();
  for (const line of raw.split("\n")) {
    const [device, mount, fsType] = line.split(" ").map(unescapeMountField);
    if (!device || !mount || !fsType || IGNORED_DISK_FS.has(fsType)) continue;
    if (!device.startsWith("/dev/") && fsType !== "zfs") continue;
    const seen = byDevice.get(device);
    if (!seen || mount.length < seen.mount.length) byDevice.set(device, { device, mount, fsType });
  }
  if (byDevice.size === 0) {
    // On macOS the root is always APFS (the Node versions Paseo runs on need macOS 11 or later), and
    // statfs reports the whole container: every volume in it, not just the system or data volume.
    return [{ device: "", mount: "/", fsType: process.platform === "darwin" ? "apfs" : "" }];
  }
  return [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

async function readDisks(signal: AbortSignal): Promise<DiskUsage[]> {
  const disks: DiskUsage[] = [];
  // One statfs at a time keeps a slow mount from occupying the worker pool.
  for (const { device, mount, fsType } of readLocalMounts()) {
    if (signal.aborted) break;
    const fs = await statfs(mount).catch(() => null);
    if (!fs?.blocks) continue;
    const totalBytes = fs.blocks * fs.bsize;
    disks.push({
      mount,
      device,
      fsType,
      totalBytes,
      usedBytes: totalBytes - fs.bfree * fs.bsize,
      availableBytes: fs.bavail * fs.bsize,
    });
  }
  return disks;
}

export type HostStats = RpcOutput<typeof hostStatsRpc>;

interface HostReading {
  current: HostSample;
  cpu: CpuTimes;
  net: NetworkTotals | null;
  memory: MemoryUsage;
}

export function startSampler(): { read(): Promise<HostStats>; stop(): void } {
  const isMac = process.platform === "darwin";
  const lifetime = new AbortController();
  const history: HostSample[] = [];
  let latest: HostReading | null = null;
  let cpuInfo: Pick<HostStats, "cpuCount" | "cpuModel"> | null = null;
  let disks: DiskUsage[] = [];
  let diskRead: Promise<void> | null = null;
  let nextDiskReadAt = 0;
  let macMemory: MemoryUsage | null = null;
  let macMemoryRead: Promise<void> | null = null;
  let nextMacMemoryReadAt = 0;

  const refreshMacMemory = (now: number) => {
    if (macMemoryRead || now < nextMacMemoryReadAt) return macMemoryRead;
    nextMacMemoryReadAt = now + MAC_MEMORY_INTERVAL_MS;
    macMemoryRead = readMacMemory(lifetime.signal)
      .then((next) => {
        if (next) macMemory = next;
      })
      .finally(() => {
        macMemoryRead = null;
      });
    return macMemoryRead;
  };

  const sample = (now: number): HostReading => {
    const elapsed = now - (latest?.current.at ?? now);
    const previous = elapsed > 0 && elapsed <= SAMPLE_GAP_MS ? latest : null;
    if (!previous) history.length = 0;
    const cpu = readCpuTimes();
    const net = readNetworkTotals();
    const seconds = elapsed / 1000;
    const totalDelta = previous ? cpu.total - previous.cpu.total : 0;
    const idleDelta = previous ? cpu.idle - previous.cpu.idle : 0;
    if (isMac) void refreshMacMemory(now);
    const memory = macMemory ?? readMemory();

    const current: HostSample = {
      at: now,
      cpuPercent: totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0,
      memoryPercent: (memory.usedBytes / memory.totalBytes) * 100,
      rxBytesPerSec: net && previous?.net ? Math.max(net.rx - previous.net.rx, 0) / seconds : 0,
      txBytesPerSec: net && previous?.net ? Math.max(net.tx - previous.net.tx, 0) / seconds : 0,
    };
    history.push(current);
    if (history.length > HISTORY_LENGTH) history.shift();
    return { current, cpu, net, memory };
  };

  const refreshDisks = (now: number) => {
    if (diskRead || now < nextDiskReadAt) return;
    nextDiskReadAt = now + DISK_INTERVAL_MS;
    diskRead = readDisks(lifetime.signal)
      .then((next) => {
        disks = next;
      })
      .catch(() => {})
      .finally(() => {
        diskRead = null;
      });
  };

  return {
    async read() {
      if (isMac && !latest && !lifetime.signal.aborted) await refreshMacMemory(Date.now());
      if (lifetime.signal.aborted) throw new Error("Host monitor stopped");
      const now = Date.now();
      if (!latest || now < latest.current.at || now - latest.current.at >= SAMPLE_INTERVAL_MS) {
        latest = sample(now);
      }
      refreshDisks(now);
      if (!cpuInfo) {
        const cpus = os.cpus();
        cpuInfo = { cpuCount: cpus.length, cpuModel: cpus[0]?.model ?? "unknown" };
      }
      const [one = 0, five = 0, fifteen = 0] = os.loadavg();
      const { current, memory, net } = latest;
      return {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        uptimeSeconds: os.uptime(),
        ...cpuInfo,
        loadAverage: [one, five, fifteen],
        memory,
        network: net ? { rxTotalBytes: net.rx, txTotalBytes: net.tx } : null,
        disks,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        current,
        history: [...history],
      };
    },
    stop() {
      lifetime.abort();
    },
  };
}
