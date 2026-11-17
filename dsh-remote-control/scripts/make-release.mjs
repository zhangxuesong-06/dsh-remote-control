#!/usr/bin/env node
/**
 * Produce a release artifact set for the self-updater:
 *   releases/dsh-external-dsh-remote-control-<version>.tgz
 *   releases/manifest.json   (version, tarball, sha256, notes, publishedAt)
 *
 * The manifest is what installed copies poll. `sha256` is mandatory: the updater refuses
 * to install any manifest without it, so never hand-edit the file without re-running this.
 *
 * Usage:
 *   node scripts/make-release.mjs                  # build + pack current version
 *   node scripts/make-release.mjs --notes "修复…"   # attach release notes
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const notesArg = process.argv.indexOf("--notes");
const notes = notesArg > -1 ? (process.argv[notesArg + 1] ?? "") : "";

const releases = join(root, "releases");
mkdirSync(releases, { recursive: true });

// 1. Build host + client so the tarball always matches src.
const tscCandidates = [
  process.env.DSH_TSC,
  join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.CMD" : "tsc"),
  "D:\\deepseek harness\\source\\node_modules\\.bin\\tsc.CMD",
].filter(Boolean);
let tscBin = tscCandidates.find((c) => existsSync(c)) ?? "tsc";

// Windows: .CMD files must go through cmd.exe; passing the path with `shell: true` would let a
// space in the path split the command, so invoke the interpreter explicitly instead.
function runBin(bin, args, opts = {}) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/c", bin, ...args], { cwd: root, stdio: "inherit", ...opts });
  }
  return execFileSync(bin, args, { cwd: root, stdio: "inherit", ...opts });
}

console.log(`building host (${tscBin})…`);
runBin(tscBin, ["-p", "tsconfig.json"]);
console.log("building client…");
execFileSync(process.execPath, ["node_modules/tsdown/dist/run.mjs"], { cwd: root, stdio: "inherit" });

// 2. Pack.
for (const f of readdirSync(releases)) {
  if (f.endsWith(".tgz")) rmSync(join(releases, f), { force: true });
}
const npm = process.platform === "win32" ? "D:\\nodejs\\npm.cmd" : "npm";
const out = runBin(npm, ["pack", "--pack-destination", releases], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" })
  .trim().split(/\r?\n/).pop();

const tgzPath = join(releases, out);
const bytes = readFileSync(tgzPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");

// 3. Manifest. `tarball` is relative so it works from any mirror/host that serves the folder.
const manifest = {
  version: pkg.version,
  tarball: out,
  sha256,
  notes: notes || `版本 ${pkg.version}`,
  publishedAt: new Date().toISOString(),
};
writeFileSync(join(releases, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log("");
console.log(`release: ${out}`);
console.log(`version: ${pkg.version}`);
console.log(`sha256:  ${sha256}`);
console.log(`manifest: ${join(releases, "manifest.json")}`);
console.log("");
console.log("下一步：把 releases/ 下的 .tgz 与 manifest.json 上传到仓库的 releases/ 目录");
console.log("（或作为 GitHub Release 附件并相应修改 manifest 里的 tarball 为绝对 URL）。");
