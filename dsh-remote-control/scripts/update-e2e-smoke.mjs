#!/usr/bin/env node
/**
 * End-to-end update rehearsal against the real release artifacts.
 *
 * Takes releases/manifest.json + its tarball, serves them over loopback HTTP, builds a fake
 * "already installed 0.13.x" directory, then runs the real download → hash check → unpack →
 * swap path and asserts the install ends up on the manifest version with user files intact.
 *
 * Safe: it never touches the plugin's own install directory.
 *
 * Usage: node scripts/update-e2e-smoke.mjs
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releases = join(root, "releases");
const manifestPath = join(releases, "manifest.json");

if (!existsSync(manifestPath)) {
  console.log("SKIP 没有 releases/manifest.json —— 先运行 node scripts/make-release.mjs");
  process.exit(0);
}

const lib = await import(new URL("../lib/updater.js", import.meta.url).href);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const server = createServer((req, res) => {
  const file = join(releases, basename((req.url ?? "/").split("?")[0]));
  if (!existsSync(file)) { res.writeHead(404); res.end("missing"); return; }
  res.writeHead(200);
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;

const work = await mkdtemp(join(tmpdir(), "dsh-upd-e2e-"));
let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`PASS ${label}`);
  else { console.log(`FAIL ${label}`); failures += 1; }
};

try {
  // The published manifest must validate as-is (tarball is relative to its own location).
  const validated = lib.validateManifest({ ...manifest, tarball: `${base}/${manifest.tarball}` }, `${base}/manifest.json`);
  check(validated.ok, "published manifest validates");
  if (!validated.ok) throw new Error(validated.error);

  // Build a fake older install.
  const install = join(work, "install");
  for (const dir of ["lib", "agent"]) {
    await cp(join(root, dir), join(install, dir), { recursive: true });
  }
  for (const f of ["README.md", "CHANGELOG.md", "cordis.patch.yml", "LICENSE"]) {
    if (existsSync(join(root, f))) await cp(join(root, f), join(install, f));
  }
  const older = "0.0.1";
  await writeFile(join(install, "package.json"),
    JSON.stringify({ name: "@dsh-external/dsh-remote-control", version: older, main: "./lib/index.js" }, null, 2));
  await writeFile(join(install, "user-data.txt"), "keep me");

  const staged = await lib.stageUpdate(validated.manifest, join(work, "cache"));
  check(staged.ok, `stage succeeds (${staged.ok ? staged.version : staged.log.join(" | ")})`);
  if (!staged.ok) throw new Error("stage failed");

  const applied = lib.applyStaged(staged.dir, install, join(work, "backups"));
  check(applied.ok, `apply succeeds (${applied.log.at(-1)})`);

  const after = JSON.parse(await readFile(join(install, "package.json"), "utf8")).version;
  check(after === manifest.version, `install upgraded ${older} → ${after}`);
  check((await readFile(join(install, "user-data.txt"), "utf8")) === "keep me", "user files preserved");
  check(existsSync(join(applied.backup ?? "", "package.json")), "backup created");
  check(existsSync(join(install, "lib", "client.js")), "client bundle present after update");
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failures += 1;
} finally {
  server.close();
  await rm(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "end-to-end update rehearsal passed" : failures + " check(s) failed"}`);
process.exit(failures === 0 ? 0 : 1);
