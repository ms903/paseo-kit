import katex from "katex";
import { observeBetterPaseo } from "./overlay";
import { defaults, parsePreferences, type Companion, type Preferences } from "./preferences";

declare const COMPANION_CSS: string;

function typeset(document: Document, tex: string, display: boolean): HTMLElement | null {
  if (!tex.trim() || tex.length > 4096) return null;
  const wrapper = document.createElement("span");
  // Opt out of Paseo's global UI font so KaTeX gets its own glyphs and metrics.
  wrapper.dataset.pmono = "";
  wrapper.dataset.paseoLatex = display ? "display" : "inline";
  wrapper.dataset.tex = tex;
  wrapper.title = tex;
  try {
    katex.render(tex, wrapper, {
      displayMode: display, output: "htmlAndMathml", trust: false,
      throwOnError: true, strict: "ignore", maxSize: 16, maxExpand: 500,
    });
    return wrapper;
  } catch {
    return null;
  }
}

// Paseo evaluates a client entry once per connected host. Share one observer
// in the window and release it when its last active installation unloads.
const instanceKey = Symbol.for("paseo-latex-companion.web.v2");
const storageKey = "paseo-latex-companion.display.v1";
interface Running extends Companion { clients: number }

function createInstance(document: Document): Running {
  const view = document.defaultView;
  const load = () => {
    try { return parsePreferences(view?.localStorage.getItem(storageKey) ?? null); }
    catch { return defaults; }
  };
  let values = load();
  const listeners = new Set<() => void>();
  const style = document.createElement("style");
  style.dataset.paseoLatexStyles = "";
  style.textContent = COMPANION_CSS;
  document.head.appendChild(style);
  let observer: ReturnType<typeof observeBetterPaseo>;
  try {
    observer = observeBetterPaseo(document, (tex, display) => {
      const element = typeset(document, tex, display);
      if (element && values.scale !== "100") element.style.fontSize = values.scale + "%";
      return element;
    }, () => values.tables);
  } catch (error) {
    style.remove();
    throw error;
  }
  function apply(next: Preferences) {
    if (values.scale === next.scale && values.tables === next.tables) return;
    values = next;
    observer.refresh();
    for (const listener of listeners) listener();
  }
  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === storageKey) apply(load());
  }
  view?.addEventListener("storage", onStorage);
  return {
    clients: 0,
    read: () => values,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(patch) {
      const next = { ...values, ...patch };
      try { view?.localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { /* A client with storage disabled can still adjust the open window. */ }
      apply(next);
    },
    stop() {
      view?.removeEventListener("storage", onStorage);
      listeners.clear();
      try { observer.stop(); } finally { style.remove(); }
    },
  };
}

// Formula size and table preferences belong to the reading client, including its connected hosts.
export function start(document: Document): Companion {
  const holder = document as Document & { [instanceKey]?: Running };
  const instance = holder[instanceKey] ??= createInstance(document);
  instance.clients++;
  let active = true;
  return {
    read: instance.read, subscribe: instance.subscribe, update: instance.update,
    stop() {
      if (!active) return;
      active = false;
      if (--instance.clients === 0) {
        delete holder[instanceKey];
        instance.stop();
      }
    },
  };
}
