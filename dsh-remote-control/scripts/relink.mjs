/**
 * Local dev helper: re-link the plugin's build dependencies as junctions
 * inside ./node_modules, pointing straight at a dsh source checkout.
 *
 * Unlike scripts/build.sh (which needs bash), this runs with plain `node` and
 * never touches anything outside this package directory. Used on the dev
 * machine when DSH_CHECKOUT cannot be exported into the harness process.
 *
 * Usage:
 *   node scripts/relink.mjs                 # default checkout D:/deepseek harness/source
 *   DSH_CHECKOUT=... node scripts/relink.mjs
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.env.DSH_CHECKOUT
  ? resolve(process.env.DSH_CHECKOUT)
  : resolve("D:/deepseek harness/source");

const links = [
  ["cordis", "vendor/cordis"],
  ["cosmokit", "vendor/cosmokit"],
  ["schemastery", "vendor/schemastery"],
  ["@deepseek-ai/dsh-tools", "packages/core/tools"],
  ["@deepseek-ai/dsh-llm", "packages/llm/llm"],
  ["@deepseek-ai/dsh-system-prompt", "packages/core/system-prompt"],
  ["@types/node", "node_modules/@types/node"],
];

for (const [name, rel] of links) {
  const target = join(checkout, rel);
  if (!existsSync(target)) throw new Error(`missing: ${target}`);
  const link = join(root, "node_modules", name);
  rmSync(link, { recursive: true, force: true });
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  console.log(`link  ${name} -> ${target}`);
}

// @standard-schema/spec lives in the pnpm store.
const specLink = join(root, "node_modules", "@standard-schema", "spec");
rmSync(join(root, "node_modules", "@standard-schema"), { recursive: true, force: true });
const pnpmDir = join(checkout, "node_modules", ".pnpm");
if (existsSync(pnpmDir)) {
  const hit = readdirSync(pnpmDir).find((d) => d.toLowerCase().startsWith("@standard-schema+spec@"));
  if (hit) {
    const specTarget = join(pnpmDir, hit, "node_modules", "@standard-schema", "spec");
    if (existsSync(specTarget)) {
      mkdirSync(dirname(specLink), { recursive: true });
      symlinkSync(specTarget, specLink, process.platform === "win32" ? "junction" : "dir");
      console.log(`link  @standard-schema/spec -> ${specTarget}`);
    }
  }
}

console.log("relink complete");
