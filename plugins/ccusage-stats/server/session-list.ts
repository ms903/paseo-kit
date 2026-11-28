import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { SESSION_PAGE_SIZE, type SessionUsage, type sessionListRpc } from "../shared/usage";

export type SessionListInput = RpcInput<typeof sessionListRpc>;
export type SessionListResult = RpcOutput<typeof sessionListRpc>;
type IndexedSession = { session: SessionUsage; day: string | undefined; id: string; models: string[] };

export function createSessionList(timezone: string) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  let indexed: readonly SessionUsage[] | undefined;
  let agents: string[] = [];
  let rows: IndexedSession[] = [];
  let ranked: IndexedSession[] | undefined;

  return (sessions: readonly SessionUsage[], input: SessionListInput, complete: boolean): SessionListResult => {
    if (indexed !== sessions) {
      indexed = sessions;
      ranked = undefined;
      agents = [...new Set(sessions.map(({ agent }) => agent))].sort();
      rows = sessions.map((session) => {
        const time = Date.parse(session.lastActivity ?? "");
        return {
          session,
          day: Number.isFinite(time) ? date.format(time) : undefined,
          id: session.id.toLowerCase(),
          models: session.models.map(({ model }) => model.toLowerCase()),
        };
      });
    }
    const { agent, since, until, sort, offset: requested = 0 } = input;
    if (sort === "tokens") {
      // Sort the whole index before paginating, keeping recency as the tie-breaker.
      ranked ??= [...rows].sort((a, b) => b.session.usage.totalTokens - a.session.usage.totalTokens);
    }
    const ordered = sort === "tokens" ? ranked! : rows;
    const search = input.search?.trim().toLowerCase();
    const matches = search || agent !== undefined || since || until ? ordered.filter(({ session, day, id, models }) =>
      (agent === undefined || session.agent === agent) &&
      (!since || (day !== undefined && day >= since)) &&
      (!until || (day !== undefined && day <= until)) &&
      (!search || id.includes(search) || models.some((model) => model.includes(search))),
    ) : ordered;
    const total = matches.length;
    const last = Math.floor(Math.max(0, total - 1) / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE;
    const offset = Math.min(requested, last);
    return {
      agents, total, offset, complete,
      sessions: matches.slice(offset, offset + SESSION_PAGE_SIZE).map(({ session }) => session),
    };
  };
}
