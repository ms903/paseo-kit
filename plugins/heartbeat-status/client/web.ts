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

type Placement = "tab" | "idle" | "adjacent";

const CLOCK_STYLES = `
[data-paseo-heartbeat] {
  --heartbeat-fallback-ink: #50686b;
  color: var(--colors-foreground-muted, var(--heartbeat-fallback-ink));
  color: color-mix(in srgb, var(--colors-foreground-muted, var(--heartbeat-fallback-ink)) 72%, #4d837f);
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  align-self: center;
  user-select: none;
}
[data-paseo-heartbeat]::before,
[data-paseo-heartbeat]::after {
  content: "";
  position: absolute;
  box-sizing: border-box;
}
[data-paseo-heartbeat]::before {
  inset: 0.5px;
  border: 1.25px solid currentColor;
  border-radius: 50%;
}
/* The dial and hour hand stay still. The longer minute hand pivots around their centre. */
[data-paseo-heartbeat]::after {
  left: 5.5px;
  top: 5.5px;
  width: 3.25px;
  height: 1px;
  border-radius: 1px;
  background: currentColor;
}
[data-paseo-heartbeat] > [data-paseo-heartbeat-minute] {
  position: absolute;
  left: 5.4px;
  top: 2.25px;
  width: 1.2px;
  height: 4.35px;
  border-radius: 1px;
  background: currentColor;
  transform-origin: 50% 3.75px;
}
@keyframes paseo-heartbeat-minute-tick {
  from { transform: rotate(0turn); }
  to { transform: rotate(1turn); }
}
@media (prefers-reduced-motion: no-preference) {
  [data-paseo-heartbeat] > [data-paseo-heartbeat-minute] {
    animation: paseo-heartbeat-minute-tick 8s steps(8, end) infinite;
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-paseo-heartbeat] > [data-paseo-heartbeat-minute] { animation: none; }
}
/* Paseo measures title text before plugins mount. Its 8px padding on both sides
   gives this chip 16px of additional content space for the dial and native 4px gap. */
[data-testid^="workspace-tab-agent_"]:has([data-paseo-heartbeat-wide]) { box-sizing: content-box; }
[data-paseo-heartbeat-placement="adjacent"] {
  align-self: flex-start;
  margin-block-start: 4px;
  margin-inline: -3px;
}
[data-paseo-heartbeat-placement="idle"] { display: none; }
/* Preserve React's idle dot so toggling the preference or changing status restores it immediately. */
[data-testid="workspace-status-indicator-done"]:has(> [data-paseo-heartbeat-placement="idle"]) > :first-child:not([data-paseo-heartbeat]) { visibility: hidden; }
[data-testid="workspace-status-indicator-done"] > [data-paseo-heartbeat-placement="idle"] {
  display: block;
  position: absolute;
  inset: 0;
  margin: auto;
}
@media (prefers-color-scheme: dark) {
  [data-paseo-heartbeat] { --heartbeat-fallback-ink: #a4b8b6; }
}
@media (forced-colors: active) {
  [data-paseo-heartbeat] { color: ButtonText; }
}
`;

/** Keep the full native title when its tab strip has room for the additional glyphs. */
function sizeTabClocks(scroll: Element, tabs: HTMLSpanElement[]): void {
  const add = scroll.querySelector('[data-testid="workspace-new-tab-button"]');
  const bounds = scroll.getBoundingClientRect();
  const end = add?.getBoundingClientRect();
  const remaining = !end ? 0 : getComputedStyle(scroll).direction === "rtl"
    ? end.left - bounds.left : bounds.right - end.right;
  const alreadyAdded = scroll.querySelectorAll("[data-paseo-heartbeat-wide]").length * 16;
  const roomy = !!end && scroll.scrollWidth <= scroll.clientWidth + 1 &&
    remaining + alreadyAdded >= tabs.length * 16 + 4;
  for (const tab of tabs) {
    if (tab.hasAttribute("data-paseo-heartbeat-wide") !== roomy) tab.toggleAttribute("data-paseo-heartbeat-wide", roomy);
  }
}

/** Decorate this client's native tab strip and sidebar without changing either React component. */
export function decorateWeb(hostId: string, locale = () => document.documentElement.lang || navigator.language): WebDecoration {
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof MutationObserver === "undefined") return unavailable;

  const style = document.createElement("style");
  style.dataset.paseoHeartbeatStyles = "";
  style.textContent = CLOCK_STYLES;
  document.head.appendChild(style);

  const activeAgents = new Map<string, HeartbeatSummary>();
  const workspaceRows = new Map<string, HeartbeatSummary[]>();
  const mountedWorkspaces = new Map<string, number>();
  const marks = new Map<Element, HTMLSpanElement>();
  const listeners = new Set<() => void>();
  const observedStrips = new Set<Element>();
  const layoutObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  let shownWorkspaces = new Set<string>();
  let shownAgents = new Set<string>();
  let pending: number | null = null;
  let disposed = false;

  function scan() {
    if (disposed) return;
    const nextMarks = new Set<Element>();
    const workspaces = new Set<string>();
    const agents = new Set<string>();
    const strips = new Map<Element, HTMLSpanElement[]>();
    function mark(anchor: Element, placement: Placement, label: string) {
      let node = marks.get(anchor);
      if (!node) {
        node = document.createElement("span");
        node.setAttribute("role", "img");
        node.dataset.paseoHeartbeat = placement === "tab" ? "tab" : "sidebar";
        const minute = document.createElement("span");
        minute.dataset.paseoHeartbeatMinute = "";
        minute.setAttribute("aria-hidden", "true");
        node.appendChild(minute);
        marks.set(anchor, node);
      }
      if (node.dataset.paseoHeartbeatPlacement !== placement) node.dataset.paseoHeartbeatPlacement = placement;
      if (placement === "idle") {
        if (node.parentElement !== anchor) anchor.appendChild(node);
      } else if (node.previousElementSibling !== anchor || node.parentElement !== anchor.parentElement) {
        anchor.after(node);
      }
      if (node.title !== label) {
        node.title = label;
        node.setAttribute("aria-label", label);
      }
      nextMarks.add(anchor);
      return node;
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
          const placement = leading.getAttribute("data-testid") === "workspace-status-indicator-done" ? "idle" : "adjacent";
          mark(leading, placement, rows.map(row => labelFor(row, locale())).join("\n"));
          workspaces.add(workspaceId);
        }
      }
      const workspaceId = workspaceOnScreen(hostId);
      if (workspaceId) {
        for (const tab of Array.from(document.querySelectorAll(TAB))) {
          const id = (tab.getAttribute("data-testid") ?? "").slice(TAB_ID.length);
          const agent = activeAgents.get(id);
          if (agent?.workspaceId !== workspaceId || !visible(tab)) continue;
          // The host draws the icon, title and optional modified dot in this order.
          const title = tab.querySelector("[data-status-bucket]")?.children[1];
          if (title?.textContent?.trim() && !title.hasAttribute("data-paseo-heartbeat")) {
            const dial = mark(title, "tab", labelFor(agent, locale()));
            const scroll = tab.closest('[data-testid="workspace-tabs-scroll"]');
            if (scroll) {
              const clocks = strips.get(scroll) ?? [];
              clocks.push(dial);
              strips.set(scroll, clocks);
            }
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
    for (const strip of observedStrips) {
      if (!strips.has(strip)) {
        layoutObserver?.unobserve(strip);
        observedStrips.delete(strip);
      }
    }
    for (const [strip, clocks] of strips) {
      if (!observedStrips.has(strip)) {
        layoutObserver?.observe(strip);
        observedStrips.add(strip);
      }
      sizeTabClocks(strip, clocks);
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
      layoutObserver?.disconnect();
      observedStrips.clear();
      navigation?.removeEventListener("currententrychange", schedule);
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("resize", schedule);
      if (pending !== null) window.cancelAnimationFrame(pending);
      for (const marker of marks.values()) marker.remove();
      style.remove();
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
