import katex from "katex";
import { observeBetterPaseo } from "./overlay";

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
const instanceKey = Symbol.for("paseo-latex-companion.web.v1");
interface Running { clients: number; stop(): void }
export function start(document: Document): () => void {
  const holder = document as Document & { [instanceKey]?: Running };
  let running = holder[instanceKey];
  if (!running) {
    const style = document.createElement("style");
    style.dataset.paseoLatexStyles = "";
    style.textContent = COMPANION_CSS;
    document.head.appendChild(style);
    let stop: () => void;
    try {
      stop = observeBetterPaseo(document, (tex, display) => typeset(document, tex, display));
    } catch (err) {
      style.remove();
      throw err;
    }
    running = { clients: 0, stop() { try { stop(); } finally { style.remove(); } } };
    holder[instanceKey] = running;
  }
  const instance = running;
  instance.clients++;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--instance.clients === 0) {
      delete holder[instanceKey];
      instance.stop();
    }
  };
}
