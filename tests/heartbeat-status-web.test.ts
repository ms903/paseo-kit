import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

// CI machines with Chrome exercise real selectors, navigation, layout and DOM mutation delivery.
const chrome = [
  process.env.CHROME_BIN, "/usr/bin/chromium", "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
].find((path): path is string => !!path && existsSync(path));

const options = { skip: !chrome, timeout: 60_000 };
test("sweeps the clock hand continuously after each marked title and in idle slots", options, () => checkWebFixture(false));
test("keeps the same clock static when reduced motion is requested", options, () => checkWebFixture(true));

async function checkWebFixture(reducedMotion: boolean) {
  const bundle = await build({
    entryPoints: ["plugins/heartbeat-status/client/web.ts"], bundle: true,
    write: false, format: "iife", globalName: "heartbeat",
    plugins: [{ name: "web-platform", setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: "web", namespace: "host" }));
      builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: 'export const Platform={OS:"web"};' }));
    } }],
  });
  const row = (key: string) => `<div data-testid="sidebar-workspace-row-${key}"><span class="slot" data-testid="workspace-status-indicator-done"><i class="native-dot"></i></span><b>Same workspace</b></div>`;
  const tab = (id: string) => `<button data-testid="workspace-tab-agent_${id}"><span data-status-bucket="done"><i></i><b>Same title</b></span></button>`;
  const page = `<!doctype html><html lang="zh-CN"><style>
    :root { --colors-foreground-muted:#575e69; } .dark { --colors-foreground-muted:#b0b6bf; }
    .slot { display:inline-flex;position:relative;align-items:center;justify-content:center;width:18px;height:20px }
    .native-dot { width:6px;height:6px;border-radius:50%;background:gray }
    [data-testid="workspace-tabs-scroll"] {display:flex;width:480px;overflow:hidden}
    button {box-sizing:border-box;width:100px;min-width:100px;flex:none;height:28px;padding:0 8px;border:0}
    [data-status-bucket] {display:flex;align-items:center;gap:4px}
    [data-status-bucket] i {width:14px;flex:none} [data-status-bucket] b {min-width:0;overflow:hidden;white-space:nowrap}
    [data-testid="workspace-new-tab-button"] {width:20px;flex:none}
    </style><body>${row("h:w")}${row("other:w")}
    <div data-testid="workspace-tabs-row"><div data-testid="workspace-tabs-scroll">${tab("active")}${tab("idle")}<i data-testid="workspace-new-tab-button">+</i></div></div>
    <script>${bundle.outputFiles[0].text}</script>
    <script>
    (async () => {
      function check(ok, message) { if (!ok) throw Error(message); }
      const get = s => document.querySelector(s);
      const tabMark = '[data-paseo-heartbeat="tab"]', sideMark = '[data-paseo-heartbeat="sidebar"]';
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a = heartbeat.decorateWeb("h"), other = heartbeat.decorateWeb("other");
      const stopBadge = a.mountWorkspace("w");
      const summary = {agentId:"active",workspaceId:"w",title:"Same title",status:"idle",direct:0,descendants:1};
      const active = get('[data-testid="workspace-tab-agent_active"]');
      const label = active.querySelector("b");
      const originalWidth = active.getBoundingClientRect().width, originalLabel = label.getBoundingClientRect().width;
      const nativeDot = get(".native-dot");
      a.update([summary]); other.update([{...summary, direct:1, descendants:0}]);
      check(get(tabMark).closest("button").dataset.testid === "workspace-tab-agent_active", "wrong same-title tab");
      check(get(tabMark).previousElementSibling === label && get(tabMark).nextElementSibling === null, "clock after title");
      check(get(tabMark).hasAttribute("data-paseo-heartbeat-wide") && Math.abs(label.getBoundingClientRect().width-originalLabel)<1, "uncut wide label");
      const slot = get(sideMark).parentElement;
      check(slot.dataset.testid === "workspace-status-indicator-done" && getComputedStyle(nativeDot).visibility === "hidden", "replace only the idle dot");
      check(slot.parentElement.dataset.testid === "sidebar-workspace-row-h:w", "wrong same-title workspace");
      const clockBox = get(sideMark).getBoundingClientRect(), slotBox = slot.getBoundingClientRect();
      check(Math.abs(clockBox.x + clockBox.width/2 - slotBox.x - slotBox.width/2)<1, "clock centered in idle slot");
      const clock = get(tabMark), minute = clock.querySelector("[data-paseo-heartbeat-minute]");
      check(minute?.getAttribute("aria-hidden") === "true" && clock.getAttribute("role") === "img", "one accessible clock");
      check(matchMedia("(prefers-reduced-motion: reduce)").matches === ${reducedMotion}, "expected system motion preference");
      const dial = () => [getComputedStyle(clock).transform, getComputedStyle(clock, "::before").transform, getComputedStyle(clock, "::after").transform].join("|");
      const readHand = () => getComputedStyle(minute).transform;
      const animation = minute.getAnimations()[0];
      if (${reducedMotion}) {
        check(!animation, "reduced motion contains no running animation");
      } else {
        check(animation?.animationName === "paseo-heartbeat-minute-sweep", "long hand has the sweep animation");
        check(getComputedStyle(minute).animationTimingFunction === "linear", "uniform angular speed");
        check(animation.effect.getTiming().duration === 6000, "six-second revolution");
        check(animation.playState === "running", "long hand advances on its own");
      }
      const still = dial(), samples = [readHand()];
      if (!${reducedMotion}) {
        // Test subsecond positions independent of the worker's compositor scheduling.
        const sweep = minute.getAnimations()[0];
        for (const time of [130, 260, 390, 520]) {
          sweep.currentTime = time;
          samples.push(readHand());
        }
        sweep.currentTime = 0;
        check(new Set(samples.slice(1)).size === 4, "different subsecond phases within the same second");
      } else {
        await frame();
        check(readHand() === samples[0], "hand remains static with reduced motion");
      }
      check(dial() === still && getComputedStyle(clock, "::after").animationName === "none", "stationary dial and short hand");
      const ink = marker => getComputedStyle(marker).color;
      const palette = {
        teal: ["rgb(0, 125, 121)", "rgb(61, 219, 217)"],
        blue: ["rgb(15, 98, 254)", "rgb(120, 169, 255)"],
        violet: ["rgb(138, 63, 252)", "rgb(212, 187, 255)"],
        amber: ["rgb(142, 106, 0)", "rgb(241, 194, 27)"],
      };
      const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
      check(ink(clock) === palette.teal[+systemDark], "default Carbon teal follows system");
      for (const [accent, colors] of Object.entries(palette)) {
        a.setSettings({ accent, animate: false });
        document.documentElement.className = "light";
        check(ink(clock) === colors[0] && ink(get(sideMark)) === colors[0], "explicit light accent " + accent);
        document.documentElement.className = "dark";
        check(ink(clock) === colors[1] && ink(get(sideMark)) === colors[1], "explicit dark accent " + accent);
      }
      check(clock === get(tabMark) && minute.getAnimations().length === 0, "disabling motion on the existing clock");
      a.setSettings({ accent: "violet", animate: true });
      check(minute.getAnimations().length === (${reducedMotion} ? 0 : 1), "restoring motion still respects device preference");
      const scroll = get('[data-testid="workspace-tabs-scroll"]');
      scroll.style.width = "201px"; window.dispatchEvent(new Event("resize")); await frame();
      check(!get(tabMark).hasAttribute("data-paseo-heartbeat-wide") && active.getBoundingClientRect().width === originalWidth, "packed strip width");
      scroll.style.width = "480px"; window.dispatchEvent(new Event("resize")); await frame();
      check(get(tabMark).hasAttribute("data-paseo-heartbeat-wide"), "restores space when widened");
      check(a.isAgentDecorated("active") && !other.isAgentDecorated("active"), "routed host");
      check(get(tabMark).title.includes("自身心跳 0 · 子会话心跳 1"), "localized inheritance");
      slot.dataset.testid = "workspace-status-indicator-running";
      await frame();
      check(get(sideMark).previousElementSibling === slot && getComputedStyle(nativeDot).visibility === "visible", "retain running icon on reused slot");
      slot.outerHTML = '<span class="slot" data-testid="workspace-status-indicator-needs_input"><i></i></span>';
      await frame();
      check(get(sideMark).previousElementSibling.dataset.testid.endsWith("needs_input"), "preserve replacement attention icon");
      const attention = get(sideMark).previousElementSibling;
      attention.dataset.testid = "workspace-status-indicator-done";
      await frame();
      check(get(sideMark).parentElement === attention && getComputedStyle(attention.firstElementChild).visibility === "hidden", "return to idle");
      get('[data-testid="workspace-tab-agent_active"]').outerHTML = ${JSON.stringify(tab("active"))};
      await frame();
      check(get(tabMark) && document.querySelectorAll(tabMark).length === 1, "recreated tab");
      stopBadge(); await frame(); check(!get(sideMark) && getComputedStyle(attention.firstElementChild).visibility === "visible", "restore original dot when hidden");
      history.pushState({}, "", "/h/other/workspace/w"); window.dispatchEvent(new PopStateEvent("popstate")); await frame();
      check(!a.isAgentDecorated("active") && other.isAgentDecorated("active"), "changed host");
      check(ink(get(tabMark)) === palette.teal[1], "each host retains its own accent");
      check(get(tabMark).title.includes("自身心跳 1 · 子会话心跳 0"), "wrong routed summary");
      other.update([]); check(!get(tabMark), "stopped heartbeat");
      a.dispose(); other.dispose(); check(!get(tabMark) && !get(sideMark), "disposed markers");
    })().then(() => fetch("/report", {method:"POST", body:"ok"}), err => fetch("/report", {method:"POST",body:String(err)}));
    </script></body></html>`;
  const profile = await mkdtemp(join(tmpdir(), "heartbeat-chrome-"));
  const report = Promise.withResolvers<string>();
  const server = createServer(async (req, res) => {
    if (req.url === "/report") {
      let result = "";
      for await (const part of req) result += part;
      report.resolve(result);
      res.end("ok");
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const proc = spawn(chrome!, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--no-first-run", "--disable-background-networking", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", ...(reducedMotion ? ["--force-prefers-reduced-motion", "--force-dark-mode"] : []),
    `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/h/h/workspace/w`], { stdio: "ignore" });
  proc.once("error", report.reject);
  proc.once("exit", code => report.reject(new Error("Chrome exited before reporting (" + code + ")")));
  const deadline = setTimeout(() => report.reject(new Error("Chrome did not finish the fixture")), 40_000);
  try {
    assert.equal(await report.promise, "ok");
  } finally {
    clearTimeout(deadline);
    const closed = new Promise<void>(r => proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("close", () => r()));
    server.closeAllConnections();
    server.close();
    proc.kill();
    await Promise.race([closed, delay(2_000, undefined, { ref: false })]);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await Promise.race([closed, delay(2_000, undefined, { ref: false })]);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}
