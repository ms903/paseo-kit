import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/build-plugin-registry.mjs", import.meta.url));

test("registry advances one published plugin while preserving the other plugin's exact pin", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "paseo-registry-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const repo = join(fixture, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Paseo Kit test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgSign", "false");
  await writeFile(join(repo, "package.json"), JSON.stringify({ repository: { url: "git+https://github.com/ms903/paseo-kit.git" } }));

  async function plugin(id: string, version: string) {
    const directory = join(repo, "plugins", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ version }));
    await writeFile(join(directory, "paseo-plugin.json"), JSON.stringify({ id, name: id, description: `View ${id}` }));
  }
  function release(id: string, version: string) {
    const tagName = `${id}-v${version}`;
    git("tag", tagName);
    return { tagName, publishedAt: "2026-11-28T00:00:00Z", isDraft: false, isPrerelease: false };
  }
  function commit(message: string) {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  }
  function build(name: string, releases: Array<ReturnType<typeof release>>) {
    const directory = join(fixture, name);
    execFileSync(process.execPath, [script, directory], {
      cwd: repo, input: releases.map((release) => JSON.stringify(release)).join("\n"), encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return directory;
  }

  await plugin("usage", "0.1.9");
  await plugin("tabs", "0.5.0");
  const initial = commit("Initial versions");
  const oldUsage = release("usage", "0.1.9");
  const tabs = release("tabs", "0.5.0");
  await plugin("usage", "0.1.10");
  const next = commit("Usage release only");
  // Annotated release tags resolve to the commit just like lightweight tags.
  git("tag", "-a", "usage-v0.1.10", "-m", "Reviewed usage release");
  const usage = { ...oldUsage, tagName: "usage-v0.1.10", publishedAt: "2026-11-29T00:00:00Z" };
  await plugin("tabs", "0.6.0");
  commit("Unreleased tabs work");
  const draft = { ...release("tabs", "0.6.0"), isDraft: true };
  const prerelease = { ...release("tabs", "1.0.0"), isPrerelease: true };

  const before = build("before", [oldUsage, tabs]);
  const after = build("after", [usage, draft, tabs, oldUsage, prerelease]);
  const detail = (directory: string, id: string) => readFile(join(directory, "plugins", "ms903", `${id}.json`), "utf8");
  assert.equal(await detail(before, "tabs"), await detail(after, "tabs"));
  assert.equal(JSON.parse(await detail(before, "usage")).artifact.commit, initial);
  assert.equal(JSON.parse(await detail(after, "usage")).artifact.commit, next);
  const index = JSON.parse(await readFile(join(after, "index.json"), "utf8"));
  assert.deepEqual(index.plugins.map(({ id }: { id: string }) => id), ["ms903/tabs", "ms903/usage"]);

  assert.throws(() => build("mismatch", [{ ...prerelease, isPrerelease: false }]), /does not match its plugin ID and version/);
});
