/**
 * Managed cloudflared for quick tunnels (no account needed).
 *
 * A quick tunnel (`cloudflared tunnel --url http://127.0.0.1:PORT`) exposes an
 * HTTP endpoint on a random *.trycloudflare.com hostname. It is HTTP-only — it
 * cannot carry raw TCP/SSH — so this is used to publish the AGENT's HTTP port,
 * not SSH. Good for temporary access to a machine without a public IP.
 *
 * The binary is downloaded from the official Cloudflare releases (same source
 * and pin dsh-bridge uses) into the plugin data dir and cached.
 */
import { execFile } from "node:child_process";
import { get as httpsGet } from "node:https";
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { arch } from "node:os";

export const CLOUDFLARED_VERSION = "2024.10.0";

interface PlatformInfo { file: string; name: string; archive: "exe" | "tgz" | "bin" }

function platformInfo(): PlatformInfo {
  const os = process.platform;
  const cpu = arch();
  const key = `${os}-${cpu}`;
  const map: Record<string, { file: string; name: string; archive: "exe" | "tgz" | "bin" }> = {
    "win32-x64": { file: "cloudflared-windows-amd64.exe", name: "cloudflared.exe", archive: "exe" },
    "win32-arm64": { file: "cloudflared-windows-arm64.exe", name: "cloudflared.exe", archive: "exe" },
    "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", name: "cloudflared", archive: "tgz" },
    "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", name: "cloudflared", archive: "tgz" },
    "linux-x64": { file: "cloudflared-linux-amd64", name: "cloudflared", archive: "bin" },
    "linux-arm64": { file: "cloudflared-linux-arm64", name: "cloudflared", archive: "bin" },
  };
  const info = map[key];
  if (!info) throw new Error(`不支持的平台：${key}`);
  return info;
}

export function cloudflaredBinDir(baseDir: string): string {
  return join(baseDir, "cloudflared");
}

export function cloudflaredBinPath(baseDir: string): string {
  return join(cloudflaredBinDir(baseDir), platformInfo().name);
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = typeof (err as { code?: number } | null)?.code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/** Path to a usable cloudflared: an existing managed copy, else one found on PATH. */
export async function resolveCloudflared(baseDir: string): Promise<{ path: string; managed: boolean } | null> {
  const managed = cloudflaredBinPath(baseDir);
  if (existsSync(managed)) {
    const r = await run(managed, ["--version"], 8_000);
    if (r.code === 0) return { path: managed, managed: true };
  }
  const onPath = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const r = await run(onPath, ["--version"], 8_000);
  if (r.code === 0) return { path: onPath, managed: false };
  // Common install locations, so an existing cloudflared is reused instead of downloading.
  const candidates = process.platform === "win32"
    ? [
        join(process.env.ProgramFiles || "C:\\Program Files", "cloudflared", "cloudflared.exe"),
        join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "cloudflared", "cloudflared.exe"),
        join(process.env.LOCALAPPDATA || "", "cloudflared", "cloudflared.exe"),
      ]
    : ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared", "/opt/homebrew/bin/cloudflared"];
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    const v = await run(c, ["--version"], 8_000);
    if (v.code === 0) return { path: c, managed: false };
  }
  return null;
}

/** Download the pinned cloudflared release into the plugin data dir. */
export async function installCloudflared(baseDir: string): Promise<{ ok: boolean; path?: string; log: string[] }> {
  const log: string[] = [];
  const info = platformInfo();
  const dir = cloudflaredBinDir(baseDir);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, info.name);
  const tmp = join(dir, info.archive === "exe" ? `download-${process.pid}.exe` : `download-${process.pid}.${info.archive}`);
  const upstream = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${info.file}`;
  // Try the official release first, then well-known mirrors: a blocked or reset GitHub
  // connection is common on some networks, and this keeps the feature self-contained.
  const sources = [
    upstream,
    `https://ghfast.top/${upstream}`,
    `https://ghproxy.net/${upstream}`,
  ];
  let dl: { ok: boolean; error?: string } = { ok: false, error: "未尝试任何下载源" };
  for (const src of sources) {
    log.push(`下载 cloudflared ${CLOUDFLARED_VERSION}：${src}`);
    dl = await download(src, tmp);
    if (dl.ok) break;
    log.push(`该源失败：${dl.error}`);
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  if (!dl.ok) {
    log.push("所有下载源均失败。可手动安装 cloudflared 后重试——插件会自动识别 PATH 或常见安装目录里的 cloudflared。");
    return { ok: false, log };
  }
  try {
    if (info.archive === "tgz") {
      const ex = await run("tar", ["-xzf", tmp, "-C", dir], 30_000);
      if (ex.code !== 0) { log.push(`解压失败：${ex.out}`); return { ok: false, log }; }
      // The tarball extracts a `cloudflared` binary into dir.
      if (existsSync(join(dir, "cloudflared"))) chmodSync(join(dir, "cloudflared"), 0o755);
    } else {
      if (existsSync(dest)) rmSync(dest, { force: true });
      // rename tmp → dest
      const { renameSync } = await import("node:fs");
      renameSync(tmp, dest);
      if (info.archive === "bin") chmodSync(dest, 0o755);
    }
    log.push("下载完成");
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  const v = await run(cloudflaredBinPath(baseDir), ["--version"], 10_000);
  if (v.code === 0) { log.push(`已就绪：${v.out.trim().split(/\r?\n/)[0]}`); return { ok: true, path: cloudflaredBinPath(baseDir), log }; }
  log.push("校验失败：无法执行 cloudflared --version");
  return { ok: false, log };
}

/**
 * Download with hard limits: connect timeout, idle (no-data) timeout, and a total deadline.
 * Without these a blocked network leaves the promise pending forever, which looks like a hang
 * to the user, so every failure resolves with an actionable message instead.
 */
function download(
  url: string,
  dest: string,
  redirect = 0,
  idleMs = 20_000,
  totalMs = 180_000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (redirect > 6) return resolve({ ok: false, error: "重定向过多" });
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let deadline: NodeJS.Timeout | null = null;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (deadline) clearTimeout(deadline);
      resolve(r);
    };
    const cleanDeadline = setTimeout(() => finish({ ok: false, error: `下载超时（${Math.round(totalMs / 1000)}s）：网络无法访问 GitHub` }), totalMs);
    deadline = cleanDeadline;
    const req = httpsGet(url, { headers: { "user-agent": "dsh-remote-control" }, timeout: idleMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (deadline) clearTimeout(deadline);
        settled = true;
        const next = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).toString();
        resolve(download(next, dest, redirect + 1, idleMs, totalMs));
        return;
      }
      if (status !== 200) { res.resume(); finish({ ok: false, error: `下载源返回 HTTP ${status}` }); return; }
      const bump = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy();
          finish({ ok: false, error: `下载停滞超过 ${Math.round(idleMs / 1000)}s：网络不稳定或 GitHub 不可达` });
        }, idleMs);
      };
      bump();
      const out = createWriteStream(dest);
      res.on("data", bump);
      res.pipe(out);
      out.on("finish", () => out.close(() => { try { req.destroy(); } catch { /* ignore */ } finish({ ok: true }); }));
      out.on("error", (e) => finish({ ok: false, error: e.message }));
    });
    req.setTimeout(idleMs, () => {
      req.destroy();
      finish({ ok: false, error: `连接 GitHub 超时（${Math.round(idleMs / 1000)}s）` });
    });
    req.on("error", (e) => finish({ ok: false, error: e.message }));
  });
}

// ── Quick tunnel lifecycle ───────────────────────────────────────────────────

export interface QuickTunnelState {
  running: boolean;
  url?: string;
  port?: number;
  startedAt?: number;
  error?: string;
  log: string[];
}

/**
 * Start a quick tunnel to a local HTTP port and capture the *.trycloudflare.com URL.
 * Keeps the process alive; call stopQuickTunnel to kill it.
 */
export class QuickTunnel {
  private child: import("node:child_process").ChildProcess | null = null;
  state: QuickTunnelState = { running: false, log: [] };

  constructor(private binPath: string, private handshakeMs = 60_000) {}

  async start(port: number): Promise<QuickTunnelState> {
    if (this.child) this.stop();
    this.state = { running: false, port, log: [] };
    const { spawn } = await import("node:child_process");
    const child = spawn(this.binPath, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) { this.state.running = true; this.state.startedAt = Date.now(); }
        else { this.state.running = false; this.state.error = error; this.stop(); }
        resolve(this.state);
      };
      const onData = (buf: Buffer) => {
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) { this.state.log.push(line.trim()); if (this.state.log.length > 200) this.state.log.shift(); }
        }
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
        if (m) finish(true);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => { if (!this.state.running) finish(false, `cloudflared 退出（code ${code}）`); else this.state.running = false; });
      child.on("error", (e) => finish(false, e.message));
      const timer = setTimeout(() => finish(false, "等待隧道地址超时（可能需要联网/被墙）"), this.handshakeMs);
    });
  }

  stop(): void {
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    this.state.running = false;
  }
}
