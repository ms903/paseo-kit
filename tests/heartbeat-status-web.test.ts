import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

// CI machines with Chrome exercise real selectors, navigation, layout and DOM mutation delivery.
const chrome = [
  process.env.CHROME_BIN, "/usr/bin/chromium", "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
].find((path): path is string => !!path && existsSync(path));

test("places hearts beside native indicators by identity across routes and removes them on cleanup", { skip: !chrome, timeout: 20_000 }, async () => {
  const bundle = await build({
    entryPoints: ["plugins/heartbeat-status/client/web.ts"], bundle: true,
    write: false, format: "iife", globalName: "heartbeat",
    plugins: [{ name: "web-platform", setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: "web", namespace: "host" }));
      builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: 'export const Platform={OS:"web"};' }));
    } }],
  });
  const row = (key: string) => `<div data-testid="sidebar-workspace-row-${key}"><i data-testid="workspace-status-indicator-done"></i>Same workspace</div>`;
  const tab = (id: string) => `<button data-testid="workspace-tab-agent_${id}"><span data-status-bucket="done"><i></i><b>Same title</b></span></button>`;
  const page = `<!doctype html><html lang="zh-CN"><body>${row("h:w")}${row("other:w")}
    <div data-testid="workspace-tabs-row">${tab("active")}${tab("idle")}</div>
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
      a.update([summary]); other.update([{...summary, direct:1, descendants:0}]);
      check(get(tabMark).closest("button").dataset.testid === "workspace-tab-agent_active", "wrong same-title tab");
      check(get(tabMark).previousElementSibling.tagName === "I" && get(tabMark).nextElementSibling.tagName === "B", "tab heart placement");
      check(get(sideMark).previousElementSibling.dataset.testid === "workspace-status-indicator-done", "sidebar leading placement");
      check(get(sideMark).parentElement.dataset.testid === "sidebar-workspace-row-h:w", "wrong same-title workspace");
      check(a.isAgentDecorated("active") && !other.isAgentDecorated("active"), "routed host");
      check(get(tabMark).title.includes("自身心跳 0 · 子会话心跳 1"), "localized inheritance");
      get('[data-testid="workspace-status-indicator-done"]').outerHTML = '<i data-testid="workspace-status-indicator-running"></i>';
      await frame();
      check(get(sideMark).previousElementSibling.dataset.testid.endsWith("running"), "replaced native spinner");
      get('[data-testid="workspace-tab-agent_active"]').outerHTML = ${JSON.stringify(tab("active"))};
      await frame();
      check(get(tabMark) && document.querySelectorAll(tabMark).length === 1, "recreated tab");
      stopBadge(); await frame(); check(!get(sideMark), "hidden sidebar preference");
      history.pushState({}, "", "/h/other/workspace/w"); window.dispatchEvent(new PopStateEvent("popstate")); await frame();
      check(!a.isAgentDecorated("active") && other.isAgentDecorated("active"), "changed host");
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
    "--disable-background-networking", `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/h/h/workspace/w`], { stdio: "ignore" });
  proc.once("error", report.reject);
  proc.once("exit", code => report.reject(new Error("Chrome exited before reporting (" + code + ")")));
  const deadline = setTimeout(() => report.reject(new Error("Chrome did not finish the fixture")), 15_000);
  try {
    assert.equal(await report.promise, "ok");
  } finally {
    clearTimeout(deadline);
    const closed = new Promise<void>(r => proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("close", () => r()));
    proc.kill();
    await closed;
    server.closeAllConnections();
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
