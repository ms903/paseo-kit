import { Lexer, type Token } from "marked";

export interface Formula {
  start: number;
  end: number;
  tex: string;
  raw: string;
}

export type Typeset = (tex: string, display: boolean) => HTMLElement | null;

function escaped(text: string, at: number): boolean {
  let i = at;
  while (i > 0 && text[i - 1] === "\\") i--;
  return (at - i) % 2 !== 0;
}

function formulaAt(text: string, start: number, dollar: boolean): Formula | null {
  const body = start + (dollar ? 1 : 2);
  if (dollar && /\s/.test(text[body] ?? "")) return null;
  const close = dollar ? "$" : "\\)";
  for (let i = body; i < text.length && i - body < 16000; i++) {
    if (text[i] === "\n" || text[i] === "\r" || text[i] === "`") return null;
    if (!text.startsWith(close, i) || escaped(text, i)) continue;
    if (dollar && (/\s/.test(text[i - 1]!) || /[\d$]/.test(text[i + 1] ?? ""))) return null;
    const tex = text.slice(body, i).trim();
    const end = i + close.length;
    return tex ? { start, end, tex, raw: text.slice(start, end) } : null;
  }
  return null;
}

function endOfLinkDestination(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\n") break;
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return start;
}

/** Offsets refer to the original Markdown and include both delimiters. */
export function inlineFormulas(text: string): Formula[] {
  if (!text.includes("$") && !text.includes("\\(")) return [];
  const result: Formula[] = [];
  const markers = /`+|~{3,}|\$+|\\\(|\]\(|<\/?[a-zA-Z][^<>\n]*>/g;
  for (let m = markers.exec(text); m; m = markers.exec(text)) {
    const marker = m[0];
    if (escaped(text, m.index)) continue;
    if ((marker[0] === "`" || marker[0] === "~") && marker.length >= 3) {
      const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
      const lineEnd = text.indexOf("\n", markers.lastIndex);
      const info = text.slice(markers.lastIndex, lineEnd < 0 ? undefined : lineEnd);
      if (/^ {0,3}$/.test(text.slice(lineStart, m.index)) && (marker[0] === "~" || !info.includes("`"))) {
        const closers = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/gm;
        closers.lastIndex = lineEnd < 0 ? text.length : lineEnd + 1;
        markers.lastIndex = text.length;
        for (let end = closers.exec(text); end; end = closers.exec(text)) {
          if (end[1]!.startsWith(marker)) { markers.lastIndex = closers.lastIndex; break; }
        }
        continue;
      }
    }
    if (marker.startsWith("`")) {
      const runs = /`+/g;
      runs.lastIndex = markers.lastIndex;
      for (let r = runs.exec(text); r; r = runs.exec(text)) {
        if (r[0] === marker) { markers.lastIndex = runs.lastIndex; break; }
      }
      continue;
    }
    if (marker === "](") {
      markers.lastIndex = endOfLinkDestination(text, markers.lastIndex);
      continue;
    }
    if (marker.startsWith("<")) {
      const rawTag = /^<(code|pre|script|style|textarea)(?=[\s>])/i.exec(marker)?.[1];
      if (rawTag) {
        const closer = new RegExp("</" + rawTag + "\\s*>", "ig");
        closer.lastIndex = markers.lastIndex;
        markers.lastIndex = closer.exec(text) ? closer.lastIndex : text.length;
      }
      continue;
    }
    if (marker !== "$" && marker !== "\\(") continue;
    const formula = formulaAt(text, m.index, marker === "$");
    if (formula) {
      result.push(formula);
      markers.lastIndex = formula.end;
    }
  }
  return result;
}

export function displayFormula(raw: string): string | null {
  const source = raw.trim();
  const close = source.startsWith("$$") ? "$$" : source.startsWith("\\[") ? "\\]" : "";
  if (!close || !source.endsWith(close)) return null;
  for (let i = source.indexOf(close, 2); i >= 0; i = source.indexOf(close, i + 1)) {
    if (escaped(source, i)) continue;
    return i === source.length - 2 ? source.slice(2, i).trim() || null : null;
  }
  return null;
}

function splitRow(line: string, math: readonly Formula[]): string[] {
  const cells: string[] = [];
  let start = 0;
  let formulaIndex = 0;
  for (let i = 0; i < line.length; i++) {
    if (i === math[formulaIndex]?.start) {
      i = math[formulaIndex++]!.end - 1;
    } else if (line[i] === "|" && !escaped(line, i)) {
      cells.push(line.slice(start, i).trim());
      start = i + 1;
    }
  }
  cells.push(line.slice(start).trim());
  if (line.startsWith("|")) cells.shift();
  if (start === line.length && line.endsWith("|")) cells.pop();
  return cells;
}

function tableCells(raw: string, width: number): string[] {
  const line = raw.trim();
  const ordinary = splitRow(line, []);
  // A complete, correctly sized row can have literal dollars in neighboring cells.
  if (ordinary.length === width || !line.includes("|")) return ordinary;
  return splitRow(line, inlineFormulas(line));
}

/** Read an original GFM table before the host's Markdown lexer has discarded surplus cells. */
export function projectTable(raw: string): { header: string[]; rows: string[][] } | null {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0]!.includes("|")) return null;
  const delimiter = splitRow(lines[1]!.trim(), []);
  if (!delimiter.length || !delimiter.every(cell => /^:?-+:?$/.test(cell))) return null;
  const header = tableCells(lines[0]!, delimiter.length);
  if (header.length !== delimiter.length) return null;
  const rows: string[][] = [];
  for (const line of lines.slice(2)) {
    if (!line.trim()) break;
    const cells = tableCells(line, header.length);
    // GFM pads short rows and ignores surplus columns.
    rows.push(header.map((_, index) => cells[index] ?? ""));
  }
  return { header, rows };
}

const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][\da-fA-F]+|#\d+|[a-z]+);/g, (entity, body: string) => {
    if (!body.startsWith("#")) return Object.hasOwn(namedEntities, body) ? namedEntities[body]! : entity;
    const hex = /^#x/i.test(body);
    const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

/** Mask TeX before lexing bold/italic text. Append only DOM nodes we create. */
export function renderCell(markdown: string, document: Document, typeset: Typeset): DocumentFragment {
  const math = inlineFormulas(markdown);
  let marker = "\uE000";
  while (markdown.includes(marker)) marker += "\uE000";
  let at = 0;
  let masked = "";
  math.forEach((formula, i) => {
    masked += markdown.slice(at, formula.start) + marker + i + marker;
    at = formula.end;
  });
  masked += markdown.slice(at);

  function appendText(parent: ParentNode, text: string): void {
    const pattern = new RegExp(marker + "(\\d+)" + marker, "g");
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const formula = math[Number(match[1])];
      if (!formula) continue;
      parent.append(decodeEntities(text.slice(start, match.index)));
      parent.append(typeset(formula.tex, false) ?? formula.raw);
      start = match.index + match[0].length;
    }
    parent.append(decodeEntities(text.slice(start)));
  }

  function draw(parent: ParentNode, runs: readonly Token[]): void {
    for (const token of runs) {
      switch (token.type) {
        case "strong":
        case "em":
        case "del": {
          const element = document.createElement(token.type);
          draw(element, token.tokens ?? []);
          parent.append(element);
          break;
        }
        case "link": {
          const href = decodeEntities(token.href);
          // Keep external links clickable; workspace-local paths remain readable.
          const link = document.createElement("a");
          if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            draw(link, token.tokens ?? []);
            parent.append(link);
          } else {
            draw(parent, token.tokens ?? []);
          }
          break;
        }
        case "codespan": {
          const code = document.createElement("code");
          code.textContent = token.text;
          parent.append(code);
          break;
        }
        case "br": parent.append(document.createElement("br")); break;
        case "image": parent.append(token.text); break;
        case "escape": parent.append(token.text); break;
        case "text": appendText(parent, token.text); break;
        default: parent.append(token.raw);
      }
    }
  }

  const fragment = document.createDocumentFragment();
  draw(fragment, Lexer.lexInline(masked, { gfm: true }));
  return fragment;
}
