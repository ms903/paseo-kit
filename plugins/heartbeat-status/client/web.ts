/// <reference lib="dom" />
import { Platform } from "react-native";
import type { HeartbeatSummary } from "../shared/heartbeat";

export interface WebDecoration {
  update(rows: readonly HeartbeatSummary[]): void;
  mountWorkspace(workspaceId: string): () => void;
  isWorkspaceDecorated(workspaceId: string): boolean;
  isAgentDecorated(agentId: string): boolean;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const noOp = () => {};
const unavailable: WebDecoration = {
  update: noOp,
  mountWorkspace: () => noOp,
  isWorkspaceDecorated: () => false,
  isAgentDecorated: () => false,
  subscribe: () => noOp,
  dispose: noOp,
};

const ROW_ID = "sidebar-workspace-row-";
const TAB_ID = "workspace-tab-agent_";
const ROW = '[data-testid^="sidebar-workspace-row-"]';
const TAB = '[data-testid="workspace-tabs-row"] [data-testid^="workspace-tab-agent_"]';
const SURFACES = `${ROW}, [data-testid="workspace-tabs-row"]`;

function visible(element: Element): boolean {
  return !element.closest('[hidden],[aria-hidden="true"]') && element.getClientRects().length > 0;
}

function sameIds(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** Match tabs only in this window's routed host and workspace. Tab ids themselves contain no host. */
function workspaceOnScreen(hostId: string): string | null {
  const route = /^\/h\/([^/]+)\/workspace\/([^/]+)/.exec(window.location.pathname);
  try {
    return route && decodeURIComponent(route[1]) === hostId ? decodeURIComponent(route[2]) : null;
  } catch {
    return null;
  }
}

function heart(anchor: Element, surface: "sidebar" | "tab"): HTMLSpanElement {
  const node = document.createElement("span");
  node.dataset.paseoHeartbeat = surface;
  node.setAttribute("role", "img");
  node.textContent = "♥︎";
  // One non-interactive glyph. Keep the native icon, label, drag handle and keyboard targets.
  node.style.cssText = "display:inline-block;align-self:flex-start;flex:none;white-space:nowrap;" +
    "user-select:none;color:#ce416e;font:bold 13px/20px system-ui,sans-serif;";
  if (surface === "tab") {
    node.style.alignSelf = "center";
    node.style.lineHeight = "1";
  } else {
    node.style.marginInline = "-3px";
  }
  anchor.after(node);
  return node;
}

/** Decorate this client's native tab strip and sidebar without changing either React component. */
export function decorateWeb(hostId: string, locale = () => document.documentElement.lang || navigator.language): WebDecoration {
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof MutationObserver === "undefined") return unavailable;

  const activeAgents = new Map<string, HeartbeatSummary>();
  const workspaceRows = new Map<string, HeartbeatSummary[]>();
  const mountedWorkspaces = new Map<string, number>();
  const marks = new Map<Element, HTMLSpanElement>();
  const listeners = new Set<() => void>();
  let shownWorkspaces = new Set<string>();
  let shownAgents = new Set<string>();
  let pending: number | null = null;
  let disposed = false;

  function scan() {
    if (disposed) return;
    const nextMarks = new Set<Element>();
    const workspaces = new Set<string>();
    const agents = new Set<string>();
    function mark(anchor: Element, surface: "sidebar" | "tab", label: string) {
      let node = marks.get(anchor);
      if (!node || !node.isConnected || node.previousElementSibling !== anchor) {
        node?.remove();
        node = heart(anchor, surface);
        marks.set(anchor, node);
      }
      if (node.title !== label) {
        node.title = label;
        node.setAttribute("aria-label", label);
      }
      nextMarks.add(anchor);
    }

    if (activeAgents.size) {
      const prefix = ROW_ID + hostId + ":";
      for (const row of Array.from(document.querySelectorAll(ROW))) {
        const id = row.getAttribute("data-testid") ?? "";
        if (!id.startsWith(prefix) || !visible(row)) continue;
        const workspaceId = id.slice(prefix.length);
        const rows = workspaceRows.get(workspaceId);
        if (!rows || !mountedWorkspaces.has(workspaceId)) continue;
        const leading = row.querySelector('[data-testid^="workspace-status-indicator-"],[data-testid^="sidebar-row-project-icon-"]');
        if (leading) {
          mark(leading, "sidebar", rows.map(row => labelFor(row, locale())).join("\n"));
          workspaces.add(workspaceId);
        }
      }
      const workspaceId = workspaceOnScreen(hostId);
      if (workspaceId) {
        for (const tab of Array.from(document.querySelectorAll(TAB))) {
          const id = (tab.getAttribute("data-testid") ?? "").slice(TAB_ID.length);
          const agent = activeAgents.get(id);
          if (agent?.workspaceId !== workspaceId || !visible(tab)) continue;
          const icon = tab.querySelector("[data-status-bucket]")?.firstElementChild;
          if (icon) {
            mark(icon, "tab", labelFor(agent, locale()));
            agents.add(id);
          }
        }
      }
    }
    for (const [anchor, marker] of marks) {
      if (!nextMarks.has(anchor)) {
        marker.remove();
        marks.delete(anchor);
      }
    }
    const changed = !sameIds(shownWorkspaces, workspaces) || !sameIds(shownAgents, agents);
    shownWorkspaces = workspaces;
    shownAgents = agents;
    if (changed) for (const listener of listeners) listener();
  }

  function schedule() {
    if (disposed || pending !== null) return;
    pending = window.requestAnimationFrame(() => { pending = null; scan(); });
  }

  const observer = new MutationObserver((changes) => {
    if (!activeAgents.size || pending !== null) return;
    // Streaming chat can produce many text/spans. Only native navigation surfaces need a rescan.
    for (const change of changes) {
      if (change.target instanceof Element &&
          (change.target.closest(SURFACES) || (change.type === "attributes" && change.target.querySelector(SURFACES)))) {
        schedule();
        return;
      }
      for (const node of [...Array.from(change.addedNodes), ...Array.from(change.removedNodes)]) {
        if (node instanceof Element && (node.matches(SURFACES) || node.querySelector(SURFACES))) { schedule(); return; }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-testid", "aria-selected", "aria-hidden"] });
  // Includes pushState/replaceState transitions on Chromium and Electron.
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("currententrychange", schedule);
  window.addEventListener("popstate", schedule);
  window.addEventListener("resize", schedule);

  return {
    update(rows) {
      if (disposed) return;
      activeAgents.clear();
      workspaceRows.clear();
      for (const row of rows) {
        if (!row.workspaceId || row.direct + row.descendants <= 0) continue;
        activeAgents.set(row.agentId, row);
        const group = workspaceRows.get(row.workspaceId) ?? [];
        group.push(row);
        workspaceRows.set(row.workspaceId, group);
      }
      scan();
    },
    mountWorkspace(workspaceId) {
      if (disposed) return noOp;
      mountedWorkspaces.set(workspaceId, (mountedWorkspaces.get(workspaceId) ?? 0) + 1);
      schedule();
      return () => {
        const remaining = (mountedWorkspaces.get(workspaceId) ?? 1) - 1;
        if (remaining) mountedWorkspaces.set(workspaceId, remaining);
        else mountedWorkspaces.delete(workspaceId);
        schedule();
      };
    },
    isWorkspaceDecorated: (id) => shownWorkspaces.has(id),
    isAgentDecorated: (id) => shownAgents.has(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      navigation?.removeEventListener("currententrychange", schedule);
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("resize", schedule);
      if (pending !== null) window.cancelAnimationFrame(pending);
      for (const marker of marks.values()) marker.remove();
      marks.clear();
      listeners.clear();
      shownAgents.clear();
      shownWorkspaces.clear();
    },
  };
}

function labelFor(row: HeartbeatSummary, locale: string): string {
  const title = row.title || row.agentId;
  return /^zh([_-]|$)/i.test(locale)
    ? `${title} · 自身心跳 ${row.direct} · 子会话心跳 ${row.descendants}`
    : `${title} · Direct heartbeats: ${row.direct} · Descendant heartbeats: ${row.descendants}`;
}
