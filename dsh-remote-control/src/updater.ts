/**
 * Self-update for the plugin.
 *
 * Design constraints, in order of importance:
 *  1. Never install anything that is not integrity-checked. A manifest without a sha256 is
 *     rejected outright; a download whose hash does not match is discarded.
 *  2. Never damage a working install. The new version is unpacked into a staging directory
 *     and validated (package name + version + expected entry points) before the live
 *     directory is touched, and the previous contents are kept as a backup for rollback.
 *  3. Never swap code under a running instance and pretend it took effect. Applying writes
 *     the new files in place for the *next* start and reports that a restart is required.
 *
 * This module only touches files inside the plugin's own install directory plus its data
 * directory; it never executes code from the downloaded package.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@dsh-external/dsh-remote-control";

export interface UpdateManifest {
  version: string;
  /** Absolute https URL, or a path relative to the manifest URL. */
  tarball: string;
  sha256: string;
  notes?: string;
  publishedAt?: string;
}

export interface UpdateState {
  /** Whether to check automatically in the background. */
  autoCheck: boolean;
  /** Whether to install a found update without asking (still requires a restart). */
  autoInstall: boolean;
  /** Manifest location; empty means the built-in default. */
  manifestUrl: string;
  /** Hours between automatic checks. */
  intervalHours: number;
  lastCheckAt?: number;
  lastCheckVersion?: string;
  lastError?: string;
  /** Version the user explicitly dismissed, so the UI can stay quiet. */
  skippedVersion?: string;
  /** Version staged and applied, pending restart. */
  pendingRestart?: string;
}

export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/zhangxuesong-06/dsh-remote-control/main/releases/manifest.json";

const DEFAULT_STATE: UpdateState = { autoCheck: true, autoInstall: false, manifestUrl: "", intervalHours: 24 };

// ── semver ───────────────────────────────────────────────────────────────────

interface Semver { major: number; minor: number; patch: number; pre: string }

export function parseSemver(input: string): Semver | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/.exec(input || "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}

/** Returns <0, 0, >0 like a comparator; unparsable versions sort below valid ones. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  // A release outranks any prerelease of the same version.
  if (!x.pre && y.pre) return 1;
  if (x.pre && !y.pre) return -1;
  return x.pre === y.pre ? 0 : (x.pre > y.pre ? 1 : -1);
}

export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

// ── state ────────────────────────────────────────────────────────────────────

export function loadUpdateState(path: string): UpdateState {
  try {
    if (!existsSync(path)) return { ...DEFAULT_STATE };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateState>;
    return {
      autoCheck: typeof raw.autoCheck === "boolean" ? raw.autoCheck : DEFAULT_STATE.autoCheck,
      autoInstall: typeof raw.autoInstall === "boolean" ? raw.autoInstall : DEFAULT_STATE.autoInstall,
      manifestUrl: typeof raw.manifestUrl === "string" ? raw.manifestUrl : "",
      intervalHours: typeof raw.intervalHours === "number" && raw.intervalHours >= 1 ? Math.min(raw.intervalHours, 24 * 30) : DEFAULT_STATE.intervalHours,
      lastCheckAt: typeof raw.lastCheckAt === "number" ? raw.lastCheckAt : undefined,
      lastCheckVersion: typeof raw.lastCheckVersion === "string" ? raw.lastCheckVersion : undefined,
      lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
      skippedVersion: typeof raw.skippedVersion === "string" ? raw.skippedVersion : undefined,
      pendingRestart: typeof raw.pendingRestart === "string" ? raw.pendingRestart : undefined,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveUpdateState(path: string, state: UpdateState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

// ── http ─────────────────────────────────────────────────────────────────────

function getText(url: string, timeoutMs = 15_000, redirect = 0): Promise<{ ok: boolean; body?: string; error?: string }> {
  return new Promise((promiseResolve) => {
    if (redirect > 5) return promiseResolve({ ok: false, error: "重定向过多" });
    let done = false;
    const finish = (r: { ok: boolean; body?: string; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      promiseResolve(r);
    };
    const timer = setTimeout(() => { req.destroy(); finish({ ok: false, error: `请求超时（${Math.round(timeoutMs / 1000)}s）` }); }, timeoutMs);
    const mod = url.startsWith("http://") ? httpGet : httpsGet;
    const req = mod(url, { headers: { "user-agent": "dsh-remote-control-updater" }, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        done = true;
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        promiseResolve(getText(next, timeoutMs, redirect + 1));
        return;
      }
      if (status !== 200) { res.resume(); finish({ ok: false, error: `HTTP ${status}` }); return; }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; if (body.length > 512 * 1024) { req.destroy(); finish({ ok: false, error: "清单过大" }); } });
      res.on("end", () => { try { req.destroy(); } catch { /* ignore */ } finish({ ok: true, body }); });
      res.on("error", (e: Error) => finish({ ok: false, error: e.message }));
    });
    req.on("timeout", () => { req.destroy(); finish({ ok: false, error: `连接超时（${Math.round(timeoutMs / 1000)}s）` }); });
    req.on("error", (e: Error) => finish({ ok: false, error: e.message }));
  });
}

/** GitHub raw/release URLs are often blocked; mirror prefixes are the usual workaround. */
function mirrored(url: string): string[] {
  if (!/^https:\/\/(raw\.githubusercontent\.com|github\.com)\//i.test(url)) return [url];
  return [url, `https://ghfast.top/${url}`, `https://ghproxy.net/${url}`];
}

export function isAllowedSource(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    // Plain http only for loopback (local testing / a self-hosted LAN mirror).
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

// ── manifest ─────────────────────────────────────────────────────────────────

export function validateManifest(raw: unknown, manifestUrl: string): { ok: true; manifest: UpdateManifest } | { ok: false; error: string } {
  const m = raw as Partial<UpdateManifest> | null;
  if (!m || typeof m !== "object") return { ok: false, error: "清单格式无效" };
  if (typeof m.version !== "string" || !parseSemver(m.version)) return { ok: false, error: "清单 version 不是合法语义化版本" };
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(m.sha256)) {
    return { ok: false, error: "清单缺少有效的 sha256，拒绝安装（完整性无法校验）" };
  }
  if (typeof m.tarball !== "string" || !m.tarball.trim()) return { ok: false, error: "清单缺少 tarball" };
  let tarball = m.tarball.trim();
  if (!/^https?:\/\//i.test(tarball)) tarball = new URL(tarball, manifestUrl).toString();
  if (!isAllowedSource(tarball)) return { ok: false, error: "tarball 必须是 https 地址（http 仅允许本机）" };
  return { ok: true, manifest: { version: m.version, tarball, sha256: m.sha256.toLowerCase(), notes: m.notes, publishedAt: m.publishedAt } };
}

export interface CheckResult {
  ok: boolean;
  current: string;
  latest?: string;
  updateAvailable: boolean;
  manifest?: UpdateManifest;
  error?: string;
  /** Manifest URL actually used (after applying defaults). */
  source?: string;
}

export async function checkForUpdate(
  currentVersion: string,
  manifestUrl?: string,
  timeoutMs = 15_000,
): Promise<CheckResult> {
  const source = (manifestUrl && manifestUrl.trim()) || DEFAULT_MANIFEST_URL;
  if (!isAllowedSource(source)) {
    return { ok: false, current: currentVersion, updateAvailable: false, error: "清单地址必须是 https（http 仅允许本机）" };
  }
  let lastError = "";
  for (const url of mirrored(source)) {
    const r = await getText(url, timeoutMs);
    if (!r.ok || !r.body) { lastError = r.error || "空响应"; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(r.body); } catch { lastError = "清单不是合法 JSON"; continue; }
    const v = validateManifest(parsed, url);
    if (!v.ok) return { ok: false, current: currentVersion, updateAvailable: false, error: v.error };
    return {
      ok: true,
      current: currentVersion,
      latest: v.manifest.version,
      updateAvailable: isNewer(v.manifest.version, currentVersion),
      manifest: v.manifest,
      source: url,
    };
  }
  return { ok: false, current: currentVersion, updateAvailable: false, error: `无法获取更新清单：${lastError}` };
}

// ── download / verify / stage ────────────────────────────────────────────────

function sha256File(path: string): Promise<string> {
  return new Promise((promiseResolve, promiseReject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (c: string | Buffer) => { hash.update(c); });
    stream.on("end", () => promiseResolve(hash.digest("hex")));
    stream.on("error", promiseReject);
  });
}

function downloadFile(url: string, dest: string, timeoutMs = 120_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((promiseResolve) => {
    let done = false;
    let idle: NodeJS.Timeout | null = null;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      promiseResolve(r);
    };
    const mod = url.startsWith("http://") ? httpGet : httpsGet;
    const req = mod(url, { headers: { "user-agent": "dsh-remote-control-updater" }, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).toString();
        done = true;
        promiseResolve(downloadFile(next, dest, timeoutMs));
        return;
      }
      if (status !== 200) { res.resume(); finish({ ok: false, error: `下载返回 HTTP ${status}` }); return; }
      const bump = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => { req.destroy(); finish({ ok: false, error: "下载停滞超时" }); }, 30_000);
      };
      bump();
      const out = createWriteStream(dest);
      res.on("data", bump);
      res.pipe(out);
      out.on("finish", () => out.close(() => { try { req.destroy(); } catch { /* ignore */ } finish({ ok: true }); }));
      out.on("error", (e) => finish({ ok: false, error: e.message }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ ok: false, error: `下载连接超时（${Math.round(timeoutMs / 1000)}s）` }); });
    req.on("error", (e) => finish({ ok: false, error: e.message }));
  });
}

function run(file: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((promiseResolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = typeof (err as unknown as { code?: number })?.code === "number"
        ? (err as unknown as { code: number }).code
        : err ? 1 : 0;
      promiseResolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/**
 * Reject archives that try to escape the extraction directory or smuggle links.
 * `tar -tvzf` prefix: d=dir, -=file, l=symlink, h=hardlink, c=char, b=block, p=fifo.
 */
export function inspectArchive(listing: string): { ok: true } | { ok: false; error: string } {
  for (const line of listing.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^[dhlcbps-]/.test(line)) continue;
    const kind = line[0];
    if (kind !== "d" && kind !== "-") return { ok: false, error: "压缩包包含符号链接或特殊文件，拒绝安装" };
    const name = line.split(/\s+/).slice(8).join(" ");
    if (!name) continue;
    if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name) || name.split(/[\\/]/).includes("..")) {
      return { ok: false, error: "压缩包包含越界路径，拒绝安装" };
    }
  }
  return { ok: true };
}

export interface StageResult {
  ok: boolean;
  dir?: string;
  version?: string;
  log: string[];
}

/** Download, hash-check and unpack a manifest's tarball into a fresh staging directory. */
export async function stageUpdate(manifest: UpdateManifest, workDir: string): Promise<StageResult> {
  const log: string[] = [];
  mkdirSync(workDir, { recursive: true });
  const stamp = String(Date.now());
  const tgz = join(workDir, `update-${stamp}.tgz`);
  const stageDir = join(workDir, `stage-${stamp}`);

  log.push(`下载 ${manifest.version}：${manifest.tarball}`);
  let dl = await downloadFile(manifest.tarball, tgz);
  if (!dl.ok) {
    // Same mirror fallback as the manifest, for blocked GitHub release URLs.
    for (const alt of mirrored(manifest.tarball).slice(1)) {
      log.push(`尝试镜像：${alt}`);
      dl = await downloadFile(alt, tgz);
      if (dl.ok) break;
    }
  }
  if (!dl.ok) return { ok: false, log: [...log, `下载失败：${dl.error}`] };

  const actual = await sha256File(tgz);
  if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
    try { rmSync(tgz, { force: true }); } catch { /* ignore */ }
    return { ok: false, log: [...log, `校验失败：sha256 不匹配（期望 ${manifest.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已丢弃`] };
  }
  log.push("sha256 校验通过");

  const listing = await run("tar", ["-tvzf", tgz], 60_000);
  if (listing.code !== 0) return { ok: false, log: [...log, `无法读取压缩包：${listing.out.trim().slice(0, 200)}`] };
  const safe = inspectArchive(listing.out);
  if (!safe.ok) return { ok: false, log: [...log, safe.error] };

  mkdirSync(stageDir, { recursive: true });
  const ex = await run("tar", ["-xzf", tgz, "-C", stageDir], 120_000);
  if (ex.code !== 0) return { ok: false, log: [...log, `解压失败：${ex.out.trim().slice(0, 200)}`] };

  // npm packs as `package/`; accept that or a flat layout.
  let root = stageDir;
  const entries = readdirSync(stageDir);
  if (entries.length === 1 && statSync(join(stageDir, entries[0])).isDirectory()) {
    root = join(stageDir, entries[0]);
  }

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, log: [...log, "压缩包内没有 package.json"] };
  let pkg: { name?: string; version?: string; main?: string };
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return { ok: false, log: [...log, "package.json 不是合法 JSON"] }; }
  if (pkg.name !== PACKAGE_NAME) return { ok: false, log: [...log, `包名不符：${pkg.name ?? "(空)"}`] };
  if (pkg.version !== manifest.version) return { ok: false, log: [...log, `包内版本 ${pkg.version ?? "(空)"} 与清单 ${manifest.version} 不一致`] };
  if (!pkg.main || !existsSync(join(root, pkg.main.replace(/^\.\//, "")))) {
    return { ok: false, log: [...log, `入口文件缺失：${pkg.main ?? "(未声明)"}`] };
  }
  log.push(`已解包并校验：${pkg.name}@${pkg.version}`);
  return { ok: true, dir: root, version: pkg.version, log };
}

// ── apply ────────────────────────────────────────────────────────────────────

/** Files/dirs that make up a release; anything else (user data) is left alone. */
const RELEASE_ENTRIES = ["lib", "agent", "package.json", "README.md", "CHANGELOG.md", "cordis.patch.yml", "LICENSE"];

export interface ApplyResult { ok: boolean; backup?: string; log: string[]; restartRequired?: boolean }

/**
 * Replace the release files in `installDir` with the staged build.
 * The previous release is copied to `backupRoot` first; any failure restores it.
 */
export function applyStaged(stagedDir: string, installDir: string, backupRoot: string): ApplyResult {
  const log: string[] = [];
  if (!existsSync(stagedDir)) return { ok: false, log: ["暂存目录不存在"] };
  if (!existsSync(join(installDir, "package.json"))) return { ok: false, log: [`安装目录无效：${installDir}`] };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = join(backupRoot, `installed-update-${stamp}`);
  try {
    mkdirSync(backup, { recursive: true });
    for (const entry of RELEASE_ENTRIES) {
      const from = join(installDir, entry);
      if (existsSync(from)) cpSync(from, join(backup, entry), { recursive: true });
    }
    log.push(`已备份到 ${backup}`);

    for (const entry of RELEASE_ENTRIES) {
      const from = join(stagedDir, entry);
      if (!existsSync(from)) continue;
      const to = join(installDir, entry);
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
    }
    log.push("已写入新版本");

    const installed = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")) as { version?: string };
    const staged = JSON.parse(readFileSync(join(stagedDir, "package.json"), "utf8")) as { version?: string };
    if (installed.version !== staged.version) throw new Error(`写入后版本不一致（${installed.version} ≠ ${staged.version}）`);
    log.push(`安装完成：${installed.version}；重启 DSH 后生效`);
    return { ok: true, backup, log, restartRequired: true };
  } catch (e) {
    log.push(`更新失败：${(e as Error).message}，正在回滚`);
    try {
      for (const entry of RELEASE_ENTRIES) {
        const from = join(backup, entry);
        if (!existsSync(from)) continue;
        const to = join(installDir, entry);
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true });
      }
      log.push("已回滚到更新前的版本");
    } catch (re) {
      log.push(`回滚也失败，请手动从备份恢复：${backup}（${(re as Error).message}）`);
    }
    return { ok: false, backup, log };
  }
}

/** Resolve the plugin's own install root from the compiled module location. */
export function installRootFromModule(moduleUrl: string): string {
  // .../lib/index.js → plugin root. fileURLToPath decodes %20 and handles Windows drive letters.
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}
