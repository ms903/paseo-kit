import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { discoverPlugins } from "./plugin-projects.mjs";

const browserOnly = /\b(?:document|window|navigator)\s*(?:\.|\[)|\blocalStorage\b|\b(?:className|onClick)\s*=/;
const companionId = "paseo-latex-companion";
// The companion's build packages these modules in a separate web-only IIFE.
const companionWeb = new Set(["client/web.ts", "client/project.ts", "client/overlay.ts"]);

async function clientFiles(project, directory = "client") {
  let entries;
  try {
    entries = await readdir(join(project, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await clientFiles(project, path));
    else if (/\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function checkCompanionNativeEntrypoint(project) {
  const entry = await readFile(join(project, "index.client.ts"), "utf8");
  const { code } = await transform(entry, { format: "cjs", loader: "ts", target: "es2020" });
  for (const OS of ["ios", "android"]) {
    const module = { exports: {} };
    const sandbox = {
      module,
      require(id) {
        assert.equal(id, "react-native");
        return { Platform: { OS } };
      },
      get document() { throw new Error(`The companion accessed a DOM global on ${OS}`); },
      Function() { throw new Error(`The companion initialized the web bundle on ${OS}`); },
    };
    runInNewContext(code, sandbox, { filename: "index.client.ts", timeout: 1000 });
    const stop = module.exports.default();
    assert.equal(typeof stop, "function");
    stop();
  }
}

const errors = [];
for (const { id, project } of await discoverPlugins()) {
  const companion = id === companionId;
  const files = await clientFiles(project);
  if (!companion) {
    const entries = await readdir(project);
    files.push(...entries.filter((file) => /^index\.client\.tsx?$/.test(file)));
  }
  for (const file of files) {
    if (file === "client/web.ts" || (companion && companionWeb.has(file))) continue;
    const text = await readFile(join(project, file), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      if (browserOnly.test(line)) errors.push(`${id}/${file}:${index + 1}: ${line.trim()}`);
    }
  }
  if (companion) await checkCompanionNativeEntrypoint(project);
  console.log(`Checked mobile entrypoints and client code for ${id}`);
}
if (errors.length) {
  throw new Error(`Browser API outside a web-only module:\n${errors.join("\n")}`);
}
