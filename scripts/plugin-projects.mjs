import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export async function discoverPlugins() {
  const directory = join(repoRoot, "plugins");
  const entries = await readdir(directory, { withFileTypes: true });
  const plugins = [];
  const ids = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const project = join(directory, entry.name);
    const manifest = join(project, "paseo-plugin.json");
    let source;
    try {
      source = await readFile(manifest, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const { id } = JSON.parse(source);
    if (typeof id !== "string" || !id || ids.has(id)) {
      throw new Error(`Invalid or duplicate plugin ID in ${manifest}`);
    }
    ids.add(id);
    plugins.push({ id, project });
  }
  if (plugins.length === 0) throw new Error(`No plugin manifests found in ${directory}`);
  return plugins;
}
