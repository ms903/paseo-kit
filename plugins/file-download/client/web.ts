// The only module that touches browser globals. Every export checks Platform.OS and does nothing
// elsewhere; the desktop app is a browser too and loads the same routes under paseo://app.
import { Platform } from "react-native";

interface DomElement {
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElement): void;
  remove(): void;
  click(): void;
}

interface KeyEvent {
  key?: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  target?: { tagName?: string; isContentEditable?: boolean; closest?(selector: string): unknown };
  defaultPrevented: boolean;
  preventDefault(): void;
}

interface PaneElement {
  parentElement: PaneElement | null;
  getClientRects(): { length: number };
  closest(selector: string): PaneElement | null;
}

declare const document: {
  createElement(tag: string): DomElement;
  body: DomElement;
  querySelectorAll(selector: string): ArrayLike<PaneElement>;
};
interface SaveWritable {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
declare const window: {
  showSaveFilePicker?(options: { suggestedName: string }): Promise<{ createWritable(): Promise<SaveWritable> }>;
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
};
declare const location: { pathname: string };
declare const navigator: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined;

// React Native types Blob with string parts only; browsers also take binary ones.
const WebBlob = Blob as unknown as new (parts: readonly Uint8Array[], options: { type: string }) => Blob;

export const isWeb = Platform.OS === "web";

const isMac =
  isWeb && /mac/i.test(navigator?.userAgentData?.platform ?? navigator?.platform ?? navigator?.userAgent ?? "");

/** The save shortcut as this platform writes it. */
export const SAVE_SHORTCUT = isMac ? "⌘S" : "Ctrl+S";

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Hands the bytes to the browser's download flow under the given file name. */
export function saveFile(parts: readonly Uint8Array[], name: string): void {
  if (!isWeb) return;
  const url = URL.createObjectURL(new WebBlob(parts, { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", name);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has its own reference by now; give slow browsers a moment anyway.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Calls `onSave` for Cmd+S on macOS and Ctrl+S elsewhere. A key press something else already
 * handled, such as the file editor saving its changes, is left alone.
 */
export function listenForSaveShortcut(onSave: (event: KeyEvent) => void): () => void {
  if (!isWeb) return () => {};
  const listener = (event: KeyEvent) => {
    if (event.defaultPrevented || event.repeat || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName ?? "") || target?.closest?.('[contenteditable="true"], .monaco-editor, .cm-editor')) return;
    // The physical S key, so the shortcut also works on layouts where it types another letter.
    // Autofill dispatches keydown events without a key, hence the fallbacks.
    if (event.code !== "KeyS" && (event.key ?? "").toLowerCase() !== "s") return;
    if (isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    onSave(event);
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

export interface FocusedTab {
  serverId: string;
  workspaceId: string;
  /** Set when the focused tab is a file preview. */
  filePath: string | null;
}

interface PaneProps {
  isPaneFocused?: boolean;
  isWorkspaceFocused?: boolean;
  content?: { paneContextValue?: { serverId?: string; workspaceId?: string; target?: { kind?: string; path?: string } } };
}

/** Paseo renders WorkspacePaneContent directly inside a host View in desktop, compact and sheet layouts. */
function readPaneProps(preview: PaneElement): PaneProps | null {
  for (let node: PaneElement | null = preview; node; node = node.parentElement) {
    // React DOM keeps the most recently committed props on the element.
    const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
    if (!key) continue;
    const children = Reflect.get(node, key)?.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const props = child?.props as PaneProps | undefined;
      if (props?.content?.paneContextValue && typeof props.isPaneFocused === "boolean" &&
          typeof props.isWorkspaceFocused === "boolean") return props;
    }
  }
  return null;
}

/** Read the rendered file preview in this window. Persisted layouts can belong to a different window. */
export function readFocusedTab(): FocusedTab | null {
  if (!isWeb) return null;
  try {
    const route = /^\/h\/([^/]+)\/workspace\/([^/?#]+)/.exec(location.pathname);
    if (!route) return null;
    const serverId = decodeURIComponent(route[1] ?? "");
    const workspaceId = decodeURIComponent(route[2] ?? "");
    const sheetSelector = '[data-testid="sheet-tab-body"]';
    const sheetOpen = Array.from(document.querySelectorAll(sheetSelector)).some((sheet) => sheet.getClientRects().length > 0);
    let filePath: string | null = null;
    for (const preview of Array.from(document.querySelectorAll('[data-testid="workspace-file-pane"]'))) {
      if (!preview.getClientRects().length || (sheetOpen && !preview.closest(sheetSelector))) continue;
      const props = readPaneProps(preview);
      const pane = props?.content?.paneContextValue;
      if (!props?.isPaneFocused || !props.isWorkspaceFocused || pane?.serverId !== serverId ||
          pane.workspaceId !== workspaceId || pane.target?.kind !== "file" ||
          typeof pane.target.path !== "string" || !pane.target.path) continue;
      if (filePath !== null) return null;
      filePath = pane.target.path;
    }
    return { serverId, workspaceId, filePath };
  } catch {
    return null;
  }
}

export interface SaveSink extends SaveWritable { validateSize(size: number): void }

/** Request the picker before RPC yields the user gesture; otherwise use a bounded Blob sink. */
export async function openSaveSink(name: string): Promise<SaveSink> {
  if (!isWeb) throw new Error("Downloads require a browser or desktop app");
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const writable = await handle.createWritable();
    return { write: (bytes) => writable.write(bytes), close: () => writable.close(), abort: () => writable.abort(), validateSize() {} };
  }
  const limit = 64 * 1024 * 1024;
  let received = 0;
  const parts: Uint8Array[] = [];
  const validateSize = (size: number) => { if (size > limit) throw new Error("Streaming file saving is unavailable for this download."); };
  return {
    validateSize,
    async write(bytes) { validateSize(received + bytes.length); received += bytes.length; parts.push(bytes); },
    async close() { saveFile(parts, name); parts.length = 0; },
    async abort() { parts.length = 0; },
  };
}
