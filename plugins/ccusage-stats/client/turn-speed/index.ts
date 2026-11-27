import { useCallback, useSyncExternalStore } from "react";
import type { TurnSpeedRuntime } from "./runtime";

export { createTurnSpeedRuntime, type TurnSpeedRuntime, type LiveTurnSpeed } from "./runtime";

export function useLiveSpeed({ runtime, agentId, windowSeconds }: {
  runtime?: TurnSpeedRuntime; agentId: string; windowSeconds: number;
}) {
  const subscribe = useCallback((listener: () => void) => runtime?.watch(agentId, listener) ?? (() => {}), [runtime, agentId]);
  const version = useCallback(() => runtime?.version() ?? 0, [runtime]);
  useSyncExternalStore(subscribe, version, version);
  return runtime?.read(agentId, windowSeconds) ?? null;
}
