import v8 from "node:v8";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createReportCache } from "./server/report";
import { createSessionSpeed, emptySpeed } from "./server/session-speed";
import { createSessionMatcher } from "./server/sessions";
import { CCUSAGE_SETTINGS } from "./shared/settings";
import { recordSessionSpeedRpc, sessionSpeedRpc } from "./shared/speed";
import { turnCalibration } from "./shared/turn-calibration";
import { sessionDetailRpc, sessionListRpc, sessionUsageRpc, updatePricesRpc, usageReportRpc } from "./shared/usage";

// The plugin process validates every daemon message with one generated function of about 11 MB
// (`safeParse_WSOutboundMessageSchema` in @getpaseo/protocol). Once it is hot, V8's Maglev compiler
// optimizes it on a worker thread, taking about 500 MB of native memory per compile, and again after
// each deopt; glibc keeps that memory, so the process grew past 2.6 GB. Turbofan already skips a
// function this large, so without Maglev it stays in the interpreter. The flag must be set before
// the function gets hot, and this bundle is evaluated before the daemon client connects.
v8.setFlagsFromString("--no-maglev");

export default function contribute(server: PluginServerContext) {
  const cache = createReportCache();
  const matcher = createSessionMatcher(cache);
  const speed = createSessionSpeed();
  const settings = server.registerSettings(CCUSAGE_SETTINGS);
  server.registerSettings(turnCalibration);
  let trackSpeed = false;
  const updateSpeed = (state: Awaited<ReturnType<typeof settings.read>>) => {
    trackSpeed = state.status === "ready" && state.values.showSessionSpeed;
    if (!trackSpeed) speed.clear();
  };
  const stopSettings = settings.subscribe(updateSpeed);
  void settings.read().then(updateSpeed).catch(() => {});
  server.handle(usageReportRpc, ({ refresh, retry, knownRevision }) => cache.read(refresh || retry, knownRevision));
  server.handle(updatePricesRpc, () => cache.updatePrices());
  server.handle(sessionListRpc, (input) => cache.listSessions(input));
  server.handle(sessionUsageRpc, (input, { paseo }) => matcher.resolve(input, paseo));
  server.handle(sessionDetailRpc, (input, { paseo }) => matcher.detail(input, paseo));
  server.handle(sessionSpeedRpc, async (input, { paseo }) => {
    const state = await settings.read();
    return state.status === "ready" && state.values.showSessionSpeed
      ? speed.read(input, paseo) : emptySpeed;
  });
  server.handle(recordSessionSpeedRpc, async (input) => {
    const state = await settings.read();
    return { recorded: state.status === "ready" && state.values.showSessionSpeed && await speed.record(input) };
  });
  // A finished turn may establish a provider session id.
  server.on("agent.turn_ended", (event, { paseo }) => {
    matcher.forget(event.agent.id);
    if (trackSpeed && event.outcome.kind === "completed") {
      void speed.complete(paseo, event.agent.id, event.turnId).catch(() => {});
    }
  });
  return async () => {
    await stopSettings?.();
    cache.stop();
    await speed.stop();
  };
}
