import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/build-plugin-registry.mjs <output-directory> < releases.jsonl");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const publishedTag = /^([a-z0-9]+(?:-[a-z0-9]+)*)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const latest = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const release = JSON.parse(line);
  const match = publishedTag.exec(release.tagName);
  if (!match || release.isDraft || release.isPrerelease) continue;
  if (typeof release.publishedAt !== "string" || !Number.isFinite(Date.parse(release.publishedAt))) {
    throw new Error(`Missing publication time for ${release.tagName}`);
  }
  const [, id, ...numbers] = match;
  const version = numbers.map(BigInt);
  const previous = latest.get(id);
  if (previous) {
    const difference = version.findIndex((part, index) => part !== previous.version[index]);
    if (difference === -1 || version[difference] < previous.version[difference]) continue;
  }
  latest.set(id, { tag: release.tagName, version, versionText: numbers.join("."), publishedAt: release.publishedAt });
}
if (latest.size === 0) throw new Error("No stable plugin releases found");

const root = git("rev-parse", "--show-toplevel").trim();
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const repo = new URL(project.repository.url.replace(/^git\+/, ""));
const repoPath = repo.pathname.replace(/^\//, "").replace(/\.git$/, "");
if (repo.origin !== "https://github.com" || !/^[a-z\d]+(?:-[a-z\d]+)*\/[a-z\d_.-]+$/i.test(repoPath)) {
  throw new Error("The registry needs the Kit's GitHub repository URL from package.json");
}
const [owner] = repoPath.toLowerCase().split("/");
const repository = `${repo.origin}/${repoPath}`;
const raw = `https://raw.githubusercontent.com/${repoPath}`;
const registry = { name: "Paseo Kit", url: `${raw}/plugin-registry` };
const categories = [{ slug: "utilities", label: "Utilities" }];

const listings = [];
for (const [id, release] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
  const commit = git("rev-parse", "--verify", `refs/tags/${release.tag}^{commit}`).trim();
  const pluginPath = `plugins/${id}`;
  const manifest = JSON.parse(git("show", `${commit}:${pluginPath}/paseo-plugin.json`));
  const pkg = JSON.parse(git("show", `${commit}:${pluginPath}/package.json`));
  if (manifest.id !== id || pkg.version !== release.versionText) {
    throw new Error(`Published tag ${release.tag} does not match its plugin ID and version`);
  }
  const description = manifest.description || pkg.description;
  if (typeof description !== "string" || !description.trim()) throw new Error(`Missing description for ${id}`);

  function assetUrl(asset) {
    if (asset.startsWith("https://")) return new URL(asset).href;
    const parts = asset.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part))) {
      throw new Error(`Invalid asset path for ${id}: ${asset}`);
    }
    git("cat-file", "-e", `${commit}:${pluginPath}/${asset}`);
    return `${raw}/${commit}/${pluginPath}/${parts.map(encodeURIComponent).join("/")}`;
  }

  const listing = {
    id: `${owner}/${id}`,
    name: manifest.name || id,
    description,
    ...(manifest.translations ? { translations: manifest.translations } : {}),
    ...(pkg.license ? { license: pkg.license } : {}),
    categories: [categories[0].slug],
    author: { github: owner },
    repository: { url: repository, commit },
    artifact: { kind: "git", remote: `${repository}.git`, commit, pluginPath },
    ...(manifest.icon ? { icon: assetUrl(manifest.icon) } : {}),
    media: (manifest.media ?? []).map(assetUrl),
    submittedAt: release.publishedAt,
    reviewedAt: release.publishedAt,
    updatedAt: release.publishedAt,
    publishedAt: release.publishedAt,
  };
  const readme = `${description}\n\nVersion ${release.versionText}. [Plugin documentation](${repository}/tree/${commit}/${pluginPath})`;
  listings.push({ listing, readme });
}

const destination = resolve(output);
await mkdir(join(destination, "plugins", owner), { recursive: true });
const write = (file, content) => writeFile(join(destination, file), JSON.stringify(content, null, 2) + "\n");
for (const { listing, readme } of listings) await write(`plugins/${listing.id}.json`, { ...listing, readme });
await write("index.json", {
  schemaVersion: 1,
  registry,
  categories,
  plugins: listings.map(({ listing }) => listing),
  featured: [],
  generatedAt: new Date(Math.max(...listings.map(({ listing }) => Date.parse(listing.publishedAt)))).toISOString(),
});
console.log(`Built registry for ${listings.length} plugins`);
