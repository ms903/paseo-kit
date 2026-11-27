import { displayFormula, inlineFormulas, projectTable, renderCell, type Typeset } from "./project";

const SURFACE = "[data-bcselection]";
const BLOCK = "[data-bcblock]";
const ROW = '[data-plugin-row][data-history-row-id^="better-paseo/"]';
const TABLE = '[data-testid="markdown-table-frame"]';
const CELL = '[data-testid="markdown-table-cell"]';
const NATIVE_MATH = "math, mjx-container, .MathJax, .katex, [data-testid=better-paseo-formula-image]";
const OUTPUT = "data-pbl-output";
const SOURCE = "data-pbl-source";

type Props = Record<string, unknown>;
interface Fiber {
  return?: Fiber;
  alternate?: Fiber;
  memoizedProps?: Props;
  stateNode?: Node;
}

interface BlockSource { raw: string; open: boolean }
type Undo = () => void;

// Better Paseo's GFM table tokenizer discards surplus cells. The mounted block
// still carries the original Markdown. Read only its current render props and
// require their full shape before using them. No React or plugin objects are changed.
function fiberFor(element: Element): Fiber | undefined {
  const keys = Object.keys(element);
  const fiberKey = keys.find(key => key.startsWith("__reactFiber$"));
  if (!fiberKey) return;
  const internals = element as unknown as Record<string, unknown>;
  const fiber = internals[fiberKey] as Fiber;
  const currentProps = internals["__reactProps$" + fiberKey.slice("__reactFiber$".length)];
  if (currentProps && fiber.alternate?.memoizedProps === currentProps) return fiber.alternate;
  return fiber;
}

function isBlock(props: Props): props is Props & BlockSource {
  return typeof props.raw === "string" && typeof props.open === "boolean" &&
    typeof props.first === "boolean" && typeof props.id === "string" && !!props.context;
}

function blockSource(element: Element): BlockSource | undefined {
  let fiber = fiberFor(element);
  for (let i = 0; fiber && i < 40; i++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props && isBlock(props)) return props;
  }
}

// On versions before data-bctlkind the original timeline renderer's payload
// identifies assistant replies. Tool results and code previews use the same MarkdownView.
function isAssistant(surface: Element): boolean {
  const scope = surface.closest("[data-bctlkind]");
  if (scope) return scope.getAttribute("data-bctlkind") === "assistant_message" &&
    scope.getAttribute("data-bctlstreaming") !== "1";
  let fiber = fiberFor(surface);
  for (let i = 0; fiber && i < 75; i++, fiber = fiber.return) {
    const item = fiber.memoizedProps?.item as { kind?: string; data?: { phase?: string } } | undefined;
    if (typeof item?.kind === "string") return item.kind === "omp-assistant" && item.data?.phase !== "streaming";
  }
  return false;
}

function textNodes(root: Element): Text[] {
  const result: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) result.push(n as Text);
  return result;
}

// Only change the value of an existing text node. It stays where React placed
// it, so later reconciliation can update or remove it normally.
function emptyText(text: Text): Undo {
  const before = text.data;
  text.data = "";
  return () => { if (text.data === "") text.data = before; };
}

function appendMirror(host: Element, fragment: DocumentFragment | HTMLElement, undos: Undo[]): void {
  const mirror = host.ownerDocument.createElement("span");
  mirror.setAttribute(OUTPUT, "");
  mirror.append(fragment);
  const restore = Array.from(host.childNodes).filter(node => node.nodeType === 3).map(node => emptyText(node as Text));
  host.setAttribute(SOURCE, "");
  host.append(mirror);
  undos.push(() => {
    mirror.remove();
    host.removeAttribute(SOURCE);
    restore.forEach(fn => fn());
  });
}

function renderRuns(host: Element, raw: string, typeset: Typeset, undos: Undo[], prefix = ""): void {
  const formulas = inlineFormulas(raw);
  if (!formulas.length) return;
  // Keep Better Paseo's own rich text, links and handlers whenever the
  // delimiter text survived Markdown parsing within the original text nodes.
  let matched = 0;
  const drafts: Array<{ node: Text; mirror: HTMLElement }> = [];
  // Only the Markdown source distinguishes an escaped dollar from a real
  // delimiter when the same expression also appears literally in the prose.
  const candidates = raw.includes("\\$") ? [] : textNodes(host);
  for (const node of candidates) {
    const parent = node.parentElement;
    if (!parent) continue;
    const code = parent.closest("code, pre, [data-pmono], [data-bccode]");
    if (code && code !== host && host.contains(code)) continue;
    const value = node.data;
    const mirror = host.ownerDocument.createElement("span");
    let offset = 0;
    for (; matched < formulas.length; matched++) {
      const formula = formulas[matched]!;
      const at = value.indexOf(formula.raw, offset);
      if (at < 0) break;
      mirror.append(value.slice(offset, at), typeset(formula.tex, false) ?? formula.raw);
      offset = at + formula.raw.length;
    }
    if (offset) {
      mirror.setAttribute(OUTPUT, "");
      mirror.append(value.slice(offset));
      drafts.push({ node, mirror });
    }
    if (matched === formulas.length) break;
  }
  if (matched !== formulas.length) {
    // Markdown may have eaten a backslash or treated a TeX underscore as
    // emphasis. Rebuild just this paragraph/cell from its actual input.
    const projection = renderCell(raw, host.ownerDocument, typeset);
    if (!projection.querySelector("[data-paseo-latex]")) return;
    if (prefix) projection.prepend(prefix);
    appendMirror(host, projection, undos);
    return;
  }
  for (const { node, mirror } of drafts) {
    if (!mirror.querySelector("[data-paseo-latex]")) continue;
    node.before(mirror);
    const restore = emptyText(node);
    undos.push(() => { mirror.remove(); restore(); });
  }
}

interface OriginalCell { text: string }
interface OriginalTable { raw: string; header: OriginalCell[]; rows: OriginalCell[][] }

function tableSource(frame: Element): OriginalTable | undefined {
  let fiber = fiberFor(frame);
  for (let i = 0; fiber && i < 35; i++, fiber = fiber.return) {
    const token = fiber.memoizedProps?.token as (OriginalTable & { type?: unknown }) | undefined;
    if (token?.type === "table" && typeof token.raw === "string" &&
        Array.isArray(token.header) && Array.isArray(token.rows)) return token;
  }
}

function drawTable(frame: Element, typeset: Typeset, undos: Undo[]): void {
  const original = tableSource(frame);
  if (!original || !inlineFormulas(original.raw).length) return;
  const table = projectTable(original.raw);
  if (!table) return;
  const rows = [table.header, ...table.rows];
  const originalRows = [original.header, ...original.rows];
  const cells = [...frame.querySelectorAll(CELL)].filter(cell => cell.closest(TABLE) === frame);
  if (cells.length !== rows.length * table.header.length) return;
  for (const [rowIndex, row] of rows.entries()) {
    if (!row.some(cell => inlineFormulas(cell).length)) continue;
    for (const [column, source] of row.entries()) {
      const cell = cells[rowIndex * row.length + column]!;
      if (originalRows[rowIndex]?.[column]?.text === source) {
        renderRuns(cell, source, typeset, undos);
        continue;
      }
      // A malformed original row may have lost the remainder of a math cell
      // AND the next column. Restore every affected cell from the same raw row.
      const run = renderCell(source, frame.ownerDocument, typeset);
      if (!run.querySelector("[data-paseo-latex]") && run.textContent === cell.textContent) continue;
      appendMirror(cell, run, undos);
    }
  }
}

function drawProse(block: Element, typeset: Typeset, undos: Undo[]): void {
  const seen = new Set<Element>();
  for (const node of textNodes(block)) {
    const element = node.parentElement;
    if (!element || element.closest(TABLE)) continue;
    let fiber = fiberFor(element);
    let host: Element | undefined;
    for (let i = 0; fiber && i < 40; i++, fiber = fiber.return) {
      if (fiber.stateNode?.nodeType === 1) host = fiber.stateNode as Element;
      const props = fiber.memoizedProps;
      if (!props || isBlock(props)) break;
      if (!host || !props.context || !Array.isArray(props.tokens)) continue;
      if (seen.has(host) || !block.contains(host)) break;
      seen.add(host);
      const runs = props.tokens as Array<{ raw?: unknown }>;
      if (runs.every(token => typeof token.raw === "string")) {
        renderRuns(host, runs.map(token => token.raw).join(""), typeset, undos,
          typeof props.prefix === "string" ? props.prefix : "");
      }
      break;
    }
  }
}

function drawSurface(surface: Element, typeset: Typeset, undos: Undo[]): void {
  if (!surface.closest(ROW) || !isAssistant(surface) || surface.parentElement?.closest(SURFACE)) return;
  const blocks = Array.from(surface.children);
  for (const block of blocks) {
    const source = blockSource(block);
    if (!source || source.open || !/\$|\\[([]/.test(source.raw) ||
        /^\s*(?:`{3,}|~{3,})/.test(source.raw) || block.querySelector(NATIVE_MATH)) continue;
    const display = displayFormula(source.raw);
    if (display) {
      const formula = typeset(display, true);
      if (formula) appendMirror(block.matches(BLOCK) ? block.firstElementChild ?? block : block, formula, undos);
      continue;
    }
    for (const frame of block.querySelectorAll(TABLE)) drawTable(frame, typeset, undos);
    drawProse(block, typeset, undos);
  }
}

/** Observe only Better Paseo's mounted reply surfaces. React keeps ownership of all of its nodes. */
export function observeBetterPaseo(document: Document, typeset: Typeset): () => void {
  const view = document.defaultView;
  if (!view || !document.documentElement) return () => {};
  const style = document.createElement("style");
  style.textContent = `[${SOURCE}] > :not([${OUTPUT}]) { display: none !important; }`;
  document.head.append(style);

  const applied = new Map<Element, Undo[]>();
  const dirty = new Set<Element>();
  let frame: number | undefined;
  function collect(root: Element) {
    if (root.matches(SURFACE)) dirty.add(root);
    for (const surface of root.querySelectorAll(SURFACE)) dirty.add(surface);
  }
  function restore(surface: Element) {
    for (const undo of applied.get(surface) ?? []) undo();
    applied.delete(surface);
  }
  const observer = new view.MutationObserver(records => {
    for (const mutation of records) {
      const target = mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement;
      const surface = target?.closest(SURFACE);
      if (surface) dirty.add(surface);
      else if (target && mutation.type === "attributes") collect(target);
      for (const node of mutation.addedNodes) if (node.nodeType === 1) collect(node as Element);
    }
    if (dirty.size || [...applied.keys()].some(surface => !surface.isConnected)) schedule();
  });
  const watch = () => observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["data-bctlstreaming", "data-bctlkind", "data-history-row-id"],
  });
  function flush() {
    frame = undefined;
    observer.disconnect();
    try {
      for (const surface of applied.keys()) if (!surface.isConnected) restore(surface);
      for (const surface of dirty) {
        restore(surface);
        if (!surface.isConnected) continue;
        const undos: Undo[] = [];
        try { drawSurface(surface, typeset, undos); }
        catch { for (const undo of undos.splice(0)) undo(); }
        if (undos.length) applied.set(surface, undos);
      }
    } finally {
      dirty.clear();
      watch();
    }
  }
  function schedule() { frame ??= view!.requestAnimationFrame(flush); }
  collect(document.documentElement);
  flush();
  return () => {
    observer.disconnect();
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    for (const surface of applied.keys()) restore(surface);
    dirty.clear();
    style.remove();
  };
}
