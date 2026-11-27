import type { HeartbeatSummary } from "../shared/heartbeat";

export const REFRESH_MS = 10_000;

/** One poll and one set of listeners per installation; all its views share this snapshot. */
export function watchHeartbeats(
  read: () => Promise<{ agents: HeartbeatSummary[] }>,
  publish: (rows: readonly HeartbeatSummary[]) => void,
) {
  let stopped = false;
  let pending = false;
  let previous = "";
  function update(rows: HeartbeatSummary[]) {
    if (stopped) return;
    const marked = rows.filter((row) => row.direct + row.descendants > 0 && row.workspaceId);
    marked.sort((left, right) => left.agentId.localeCompare(right.agentId));
    const key = JSON.stringify(marked);
    if (key === previous) return;
    previous = key;
    publish(marked);
  }
  async function refresh() {
    if (stopped || pending) return;
    pending = true;
    try {
      update((await read()).agents);
    } catch {
      // During a disconnect the last snapshot cannot establish that a schedule is still enabled.
      update([]);
    } finally {
      pending = false;
    }
  }
  const interval = setInterval(() => { void refresh(); }, REFRESH_MS);
  void refresh();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export function labelKey({ direct, descendants }: HeartbeatSummary) {
  if (direct && descendants) return "both";
  return direct ? "direct" : "children";
}
