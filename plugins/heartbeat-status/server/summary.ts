import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { HeartbeatSummary } from "../shared/heartbeat";

type Paseo = Pick<PluginHandlerContext["paseo"], "agents">;
type Agent = Awaited<ReturnType<Paseo["agents"]["list"]>>["entries"][number]["agent"];
type Inventory = Map<string, HeartbeatSummary>;

const PAGE_SIZE = 200;
const INVENTORY_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 3_000;
const CACHE_MS = 2_000;
const HEARTBEAT_PREFIX = "heartbeat:";

function blankSummary(agentId: string, agent?: Agent): HeartbeatSummary {
  return {
    agentId,
    workspaceId: agent?.workspaceId ?? null,
    title: agent?.title ?? null,
    status: agent?.status ?? null,
    direct: 0,
    descendants: 0,
  };
}

async function listAgents(paseo: Paseo): Promise<Map<string, Agent>> {
  const agents = new Map<string, Agent>();
  const visited = new Set<string>();
  let cursor: string | null | undefined;
  do {
    if (cursor) {
      if (visited.has(cursor)) throw new Error("Paseo agent pagination did not advance");
      visited.add(cursor);
    }
    const { entries, pageInfo } = await paseo.agents.list({
      includeBackground: true,
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      sort: [{ key: "created_at", direction: "asc" }],
      timeout: REQUEST_TIMEOUT_MS,
    });
    for (const { agent } of entries) {
      if (agent.archivedAt || agent.internal) agents.delete(agent.id);
      else agents.set(agent.id, agent);
    }
    cursor = pageInfo.nextCursor;
  } while (cursor);
  return agents;
}

async function readHeartbeatOwners(paseo: Paseo, agents: Agent[]): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  // An advertised count can disappear before the inventory request reaches the host.
  // A failed read proves no item is safe to report for that agent on this pass.
  const readAgent = async ({ id }: Agent) => {
    try {
      const items = await paseo.agents.ref(id).backgroundWork.list({ timeout: REQUEST_TIMEOUT_MS });
      for (const item of items) {
        // The daemon reserves this namespace and escapes any provider item with the same prefix.
        if (item.kind !== "heartbeat" || !item.id.startsWith(HEARTBEAT_PREFIX) || item.id.length === HEARTBEAT_PREFIX.length) continue;
        const previous = owners.get(item.id);
        owners.set(item.id, previous === undefined || previous === id ? id : null);
      }
    } catch {
      // The next pass uses a fresh agent and work inventory.
    }
  };

  let next = 0;
  async function readWork() {
    while (next < agents.length) {
      const agent = agents[next++]!;
      await readAgent(agent);
    }
  }
  await Promise.all(Array.from({ length: Math.min(INVENTORY_CONCURRENCY, agents.length) }, readWork));
  return owners;
}

function rollUpDescendants(agents: Map<string, Agent>, inventory: Inventory, paseo: Paseo) {
  const parentOf = new Map<string, string>();
  const childrenLeft = new Map<string, number>();
  for (const [id, agent] of agents) {
    const parentId = agent.labels?.["paseo.parent-agent-id"]?.trim();
    if (!parentId || parentId === id || !agents.has(parentId)) continue;

    const parentHost = agent.labels?.["paseo.parent-server-id"]?.trim();
    if (parentHost && parentHost !== paseo.agents.ref(id).address.serverId) continue;

    parentOf.set(id, parentId);
    childrenLeft.set(parentId, (childrenLeft.get(parentId) ?? 0) + 1);
  }

  // Process leaves first. Invalid parent cycles retain their own heartbeat counts
  // and those of their real descendants without propagating around the cycle.
  const leaves = [...agents.keys()].filter((id) => !childrenLeft.has(id));
  for (let index = 0; index < leaves.length; index++) {
    const id = leaves[index]!;
    const parentId = parentOf.get(id);
    if (!parentId) continue;

    const child = inventory.get(id)!;
    inventory.get(parentId)!.descendants += child.direct + child.descendants;
    const remaining = childrenLeft.get(parentId)! - 1;
    childrenLeft.set(parentId, remaining);
    if (remaining === 0) leaves.push(parentId);
  }
}

async function readInventory(paseo: Paseo): Promise<Inventory> {
  const agents = await listAgents(paseo);
  // Native heartbeats contribute to count but never to runningCount. The wire
  // contract omits runningCount when every item counts as running.
  const candidates = [...agents.values()].filter(({ backgroundWork }) =>
    backgroundWork && backgroundWork.count > (backgroundWork.runningCount ?? backgroundWork.count));
  const owners = await readHeartbeatOwners(paseo, candidates);
  const inventory = new Map([...agents].map(([id, agent]) => [id, blankSummary(id, agent)]));
  for (const owner of owners.values()) {
    if (owner !== null) inventory.get(owner)!.direct++;
  }
  rollUpDescendants(agents, inventory, paseo);
  return inventory;
}

/** The plugin process talks to one daemon. Share one consistent inventory across its clients. */
export function createHeartbeatSummaryReader(now = Date.now) {
  let cache: { inventory: Inventory; expiresAt: number } | undefined;
  let inFlight: Promise<Inventory> | undefined;

  async function inventoryForHost(paseo: Paseo): Promise<Inventory> {
    if (cache && cache.expiresAt > now()) return cache.inventory;
    inFlight ??= readInventory(paseo).then((inventory) => {
      cache = { inventory, expiresAt: now() + CACHE_MS };
      return inventory;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return async function readSummary(paseo: Paseo, agentIds: readonly string[]): Promise<HeartbeatSummary[]> {
    const inventory = await inventoryForHost(paseo);
    return agentIds.length === 0
      ? [...inventory.values()].filter(({ direct, descendants }) => direct + descendants > 0)
      : [...new Set(agentIds)].map((id) => inventory.get(id) ?? blankSummary(id));
  };
}
