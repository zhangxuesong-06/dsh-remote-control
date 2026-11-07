#!/usr/bin/env node
/**
 * dsh-remote-agent — 零依赖的远程控制代理（目标机侧）。
 *
 * 让 DeepSeek Harness 的 dsh-remote-control 插件远程控制本机：
 *   GET  /health                健康检查
 *   GET  /sysinfo               系统信息
 *   POST /exec                  执行 shell 命令（Windows: cmd.exe /c；其它: sh -c）
 *   POST /fs                    list/stat/read/write/append/mkdir/delete/rename
 *   POST /upload?path=...       原始字节流上传（写文件）
 *   GET  /download?path=...     原始字节流下载（读文件）
 *   GET  /processes             进程列表
 *   POST /process/kill          结束进程（含整个进程树）
 *   POST /job/start             后台启动长命令，立即返回 job id
 *   GET  /job/list              后台任务列表（含状态）
 *   GET  /job/output?id=...     后台任务输出（stdout/stderr，超过 max-output 截断）
 *   POST /job/kill              结束后台任务（含整个进程树）
 *
 * 认证：Authorization: Bearer <token> 或 X-DSH-Token: <token>。
 * 依赖：仅 Node.js 18+（DeepSeek Harness 安装包自带 Node，目标机无需另装）。
 *
 * 启动示例：
 *   node dsh-remote-agent.mjs --port 5188 --token dsh-rc-xxxx
 * 全部参数也支持环境变量：DSH_RC_PORT / DSH_RC_TOKEN / DSH_RC_HOST /
 * DSH_RC_NAME / DSH_RC_ROOT / DSH_RC_CERT / DSH_RC_KEY / DSH_RC_MAX_OUTPUT /
 * DSH_RC_MAX_UPLOAD / DSH_RC_MAX_EXEC_TIMEOUT。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = "1.5.0";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
process.title = "dsh-remote-agent";

// ── 参数解析 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    port: Number(process.env.DSH_RC_PORT || 5188),
    token: process.env.DSH_RC_TOKEN || "",
    tokenSha256: process.env.DSH_RC_TOKEN_SHA256 || "",
    host: process.env.DSH_RC_HOST || "0.0.0.0",
    name: process.env.DSH_RC_NAME || os.hostname(),
    root: process.env.DSH_RC_ROOT || "",
    workspace: process.env.DSH_RC_WORKSPACE || "",
    cert: process.env.DSH_RC_CERT || "",
    key: process.env.DSH_RC_KEY || "",
    reverse: process.env.DSH_RC_REVERSE || "",
    reversePool: Number(process.env.DSH_RC_REVERSE_POOL || 4),
    maxOutput: Number(process.env.DSH_RC_MAX_OUTPUT || 1024 * 1024),
    maxUpload: Number(process.env.DSH_RC_MAX_UPLOAD || 1024 * 1024 * 1024),
    maxExecTimeout: Number(process.env.DSH_RC_MAX_EXEC_TIMEOUT || 60 * 60 * 1000),
    keepAwake: false, // Opt-in CLI flag only; never change persistent OS power settings.
  };
  const HELP = [
    "dsh-remote-agent — DeepSeek Harness 远程控制代理",
    "",
    "用法: node dsh-remote-agent.mjs [选项]",
    "  --port <n>          监听端口（默认 5188，env DSH_RC_PORT）",
    "  --token <s>         共享密钥；缺省自动生成并写入 agent-token.txt",
    "  --token-sha256 <h>  以 64 位十六进制 SHA-256 存 token（与 --token 二选一）",
    "  --host <ip>         监听地址（默认 0.0.0.0）",
    "  --name <s>          本机显示名（默认 hostname）",
    "  --root <dir>        路径沙箱：所有 fs 操作限制在该目录内（默认不限制）",
    "  --workspace <dir>    默认工作区目录（启动时自动创建，经 /health 上报给控制器）",
    "  --cert <file>       TLS 证书（与 --key 同时提供则启用 HTTPS）",
    "  --key <file>        TLS 私钥",
    "  --reverse <h:p>     反向隧道：定时回连 harness 网关（自动重连，env DSH_RC_REVERSE）",
    "  --reverse-pool <n>  反向隧道连接池大小（默认 4）",
    "  --max-output <n>    单次命令/文件读取输出上限字节（默认 1048576）",
    "  --max-upload <n>    上传大小上限字节（默认 1073741824）",
    "  --max-exec-timeout <n> 命令超时上限毫秒（默认 3600000）",
    "  --keep-awake        可选：阻止系统自动休眠（默认关闭，不阻止显示器休眠）",
    "  --help              显示本帮助",
  ];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP.join("\n"));
      process.exit(0);
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "keep-awake") {
      opts.keepAwake = true;
      continue;
    }
    if (key === "port" || key === "token" || key === "token-sha256" || key === "host" || key === "name" || key === "root" || key === "workspace" || key === "cert" || key === "key" || key === "reverse" || key === "reverse-pool" || key === "max-output" || key === "max-upload" || key === "max-exec-timeout") {
      if (next === undefined || next.startsWith("--")) fail(`缺少参数值: ${arg}`);
      if (key === "port") opts.port = Number(next);
      else if (key === "token-sha256") opts.tokenSha256 = next;
      else if (key === "reverse-pool") opts.reversePool = Number(next);
      else if (key === "max-output") opts.maxOutput = Number(next);
      else if (key === "max-upload") opts.maxUpload = Number(next);
      else if (key === "max-exec-timeout") opts.maxExecTimeout = Number(next);
      else opts[key] = next;
      i++;
    } else {
      fail(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) fail(`端口非法: ${opts.port}`);
  if (!Number.isInteger(opts.reversePool) || opts.reversePool < 1 || opts.reversePool > 64) fail(`--reverse-pool 取值 1..64`);
  if (!Number.isFinite(opts.maxOutput) || opts.maxOutput < 1024) fail(`--max-output 至少 1024 字节`);
  if (!Number.isFinite(opts.maxUpload) || opts.maxUpload < 1024) fail(`--max-upload 至少 1024 字节`);
  if (!Number.isInteger(opts.maxExecTimeout) || opts.maxExecTimeout < 1 || opts.maxExecTimeout > 2_147_483_647) {
    fail("--max-exec-timeout 必须是 1..2147483647 的整数毫秒");
  }
  return opts;
}

function fail(message) {
  console.error(`[dsh-remote-agent] 错误: ${message}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const MAX_OUTPUT = opts.maxOutput;
const MAX_UPLOAD = opts.maxUpload;
const MAX_EXEC_TIMEOUT = opts.maxExecTimeout;
const MAX_JSON_BODY = 32 * 1024 * 1024;

// 默认工作区：启动时创建，保证控制器一步连接后即可使用。
if (opts.workspace) {
  opts.workspace = path.resolve(opts.workspace);
  try {
    fs.mkdirSync(opts.workspace, { recursive: true });
    console.log(`[dsh-remote-agent] 工作区: ${opts.workspace}`);
  } catch (error) {
    console.error(`[dsh-remote-agent] 警告: 无法创建工作区 ${opts.workspace}: ${error.message}`);
  }
}

// ── Token 管理 ──────────────────────────────────────────────────────────────
let tokenGenerated = false;
if (opts.tokenSha256) {
  if (!/^[0-9a-fA-F]{64}$/.test(opts.tokenSha256)) fail("--token-sha256 必须是 64 位十六进制 SHA-256");
} else if (!opts.token) {
  opts.token = `dsh-rc-${crypto.randomBytes(16).toString("hex")}`;
  tokenGenerated = true;
  const tokenFile = path.join(SCRIPT_DIR, "agent-token.txt");
  try {
    fs.writeFileSync(tokenFile, opts.token + "\n", { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
  } catch {
    // 只读目录等场景下仅打印，不阻塞启动。
  }
}

const tokenDigest = opts.tokenSha256
  ? Buffer.from(opts.tokenSha256, "hex")
  : crypto.createHash("sha256").update(opts.token).digest();

function authorized(req) {
  const header = req.headers["authorization"] || "";
  const alt = req.headers["x-dsh-token"] || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : String(alt).trim();
  if (!supplied) return false;
  // Legacy hash mode treats the hash as a bearer-equivalent credential.
  // Protect it like a token; it is not an at-rest security boundary.
  if (opts.tokenSha256) {
    return safeEqual(Buffer.from(supplied, "utf8"), Buffer.from(opts.tokenSha256, "utf8"));
  }
  const digest = crypto.createHash("sha256").update(supplied).digest();
  return safeEqual(digest, tokenDigest);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "x-dsh-agent": VERSION,
  });
  res.end(body);
}

function ok(res, data = null) {
  sendJson(res, 200, { ok: true, data });
}

function failResponse(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "BODY_TOO_LARGE", `请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BODY);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_JSON", "请求体不是合法 JSON");
  }
}

// ── 路径处理 ────────────────────────────────────────────────────────────────
function resolvePath(input) {
  const raw = String(input ?? "");
  if (!raw) throw new HttpError(400, "BAD_PATH", "缺少 path 参数");
  const root = opts.root ? path.resolve(opts.root) : null;
  if (root) {
    const resolved = path.resolve(root, raw);
    const contained = (base, target) => {
      const rel = path.relative(base, target);
      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    };
    if (!contained(root, resolved)) {
      throw new HttpError(400, "PATH_DENIED", `路径超出 --root 文件操作范围: ${raw}`);
    }
    // Check existing paths AND the closest existing ancestor of a new path.
    // realpath follows Windows junctions too. Broken links fail closed.
    // This guards file APIs, not shell commands; it is not a race-free OS sandbox.
    let ancestor = resolved;
    try {
      const realRoot = fs.realpathSync(root);
      while (true) {
        try { fs.lstatSync(ancestor); break; }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw error;
          ancestor = parent;
        }
      }
      if (!contained(realRoot, fs.realpathSync(ancestor))) throw new Error("link escapes root");
    } catch {
      throw new HttpError(400, "PATH_DENIED", `无法验证 --root 内的真实路径（链接/目录不可达或超出范围）: ${raw}`);
    }
    return resolved;
  }
  return path.resolve(raw);
}

function guardDestructiveDelete(target) {
  if (target === path.parse(target).root) {
    throw new HttpError(400, "REFUSE_ROOT", "拒绝删除磁盘根目录");
  }
  if (opts.root && path.resolve(opts.root) === target) {
    throw new HttpError(400, "REFUSE_ROOT", "拒绝删除 --root 目录本身");
  }
}

// ── 输出解码：中文 Windows 的 GBK 输出自动识别 ───────────────────────────────
function decodeOutput(buf) {
  if (process.platform === "win32") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      try {
        return new TextDecoder("gbk").decode(buf);
      } catch {
        return buf.toString("utf8");
      }
    }
  }
  return buf.toString("utf8");
}

// ── 命令执行 ────────────────────────────────────────────────────────────────
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => {}); // Cleanup failure must not crash the agent.
    } else if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // 进程组已退出。
        }
      }, 3000).unref();
    }
  } catch {
    // 进程已退出。
  }
}

/** 校验并返回 spawn 的工作目录；不存在或不是目录时返回 400。 */
function resolveSpawnCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return undefined;
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) throw new Error("not a directory");
    return cwd;
  } catch {
    throw new HttpError(400, "BAD_CWD", `工作目录不存在或不是目录: ${cwd}`);
  }
}

async function runCommand(command, { cwd, env, timeoutMs } = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new HttpError(400, "BAD_COMMAND", "缺少 command 参数");
  }
  const timeout = Math.min(Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000, MAX_EXEC_TIMEOUT);
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const spawnEnv = { ...process.env };
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      spawnEnv[key] = String(value);
    }
  }
  const spawnCwd = resolveSpawnCwd(cwd);

  const startedAt = Date.now();
  const child = spawn(shell, shellArgs, {
    cwd: spawnCwd,
    env: spawnEnv,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutDropped = false;
    let stderrDropped = false;
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    child.stdout.on("data", (chunk) => {
      if (stdout.length >= MAX_OUTPUT) {
        stdoutDropped = true;
        return;
      }
      const room = MAX_OUTPUT - stdout.length;
      stdout = Buffer.concat([stdout, chunk.subarray(0, Math.min(chunk.length, room))]);
      if (chunk.length > room) stdoutDropped = true;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_OUTPUT) {
        stderrDropped = true;
        return;
      }
      const room = MAX_OUTPUT - stderr.length;
      stderr = Buffer.concat([stderr, chunk.subarray(0, Math.min(chunk.length, room))]);
      if (chunk.length > room) stderrDropped = true;
    });
    child.on("error", (error) => {
      finish({
        command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: `启动命令失败: ${error.message}`,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: false,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        command,
        exitCode: code,
        signal,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: stdoutDropped || stderrDropped,
      });
    });
  });
}

// ── 可选系统唤醒请求：只阻止系统自动休眠，不修改电源设置/显示器状态 ───────────
const keepAwakeStatus = { requested: opts.keepAwake, state: "disabled", error: null };
let awakeChild = null;
let awakeStartupTimer = null;

function stopKeepAwake() {
  clearTimeout(awakeStartupTimer);
  awakeStartupTimer = null;
  const child = awakeChild;
  awakeChild = null;
  if (keepAwakeStatus.state !== "disabled") keepAwakeStatus.state = "stopped";
  if (child) killTree(child);
}

function startKeepAwake() {
  if (!opts.keepAwake || awakeChild || keepAwakeStatus.state === "stopped") return;
  keepAwakeStatus.state = "starting";
  let command;
  let args;
  if (process.platform === "win32") {
    command = "powershell.exe";
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", [
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class DshSystemAwake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }\'',
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED; deliberately no ES_DISPLAY_REQUIRED.
      '$ErrorActionPreference="Stop"',
      'try {',
      'if ([DshSystemAwake]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw "SetThreadExecutionState failed" }',
      '[Console]::Out.WriteLine("DSH_AWAKE_READY"); [Console]::Out.Flush()',
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
      '} finally { [void][DshSystemAwake]::SetThreadExecutionState([uint32]2147483648) }',
    ].join("\n")];
  } else if (process.platform === "darwin" || process.platform === "linux") {
    // Wrappers acquire the inhibitor before running the child, so READY confirms
    // acquisition rather than merely observing a successfully spawned process.
    const watchParent = `process.stdout.write('DSH_AWAKE_READY\\n');setInterval(()=>{try{process.kill(${process.pid},0)}catch{process.exit(0)}},5000)`;
    command = process.platform === "darwin" ? "caffeinate" : "systemd-inhibit";
    args = process.platform === "darwin"
      ? ["-i", process.execPath, "-e", watchParent]
      : ["--what=idle:sleep", "--mode=block", "--who=dsh-remote-agent", "--why=Remote agent keep-awake requested", "--", process.execPath, "-e", watchParent];
  } else {
    keepAwakeStatus.state = "unavailable";
    keepAwakeStatus.error = `不支持的平台: ${process.platform}`;
    return;
  }

  const failed = (message) => {
    clearTimeout(awakeStartupTimer);
    awakeStartupTimer = null;
    keepAwakeStatus.state = "failed";
    keepAwakeStatus.error = String(message).slice(0, 512);
    const child = awakeChild;
    awakeChild = null;
    if (child) killTree(child);
  };
  try {
    const child = spawn(command, args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    awakeChild = child;
    let readiness = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      readiness = (readiness + chunk.toString("utf8")).slice(-256);
      if (awakeChild === child && readiness.split(/\r?\n/).includes("DSH_AWAKE_READY")) {
        clearTimeout(awakeStartupTimer);
        awakeStartupTimer = null;
        keepAwakeStatus.state = "active";
        keepAwakeStatus.error = null;
      }
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + decodeOutput(chunk)).slice(-512); });
    child.once("error", (error) => { if (awakeChild === child) failed(error.message); });
    child.once("exit", (code, signal) => {
      if (awakeChild === child) failed(stderr.trim() || `唤醒辅助进程退出: ${code ?? signal}`);
    });
    awakeStartupTimer = setTimeout(() => {
      if (awakeChild === child) failed("唤醒辅助进程在 5 秒内未就绪");
    }, 5_000);
    awakeStartupTimer.unref?.();
  } catch (error) {
    failed(error.message);
  }
}

// ── 后台作业：长命令不占用 HTTP 请求 ────────────────────────────────────────
const JOBS = new Map();
const MAX_JOBS = 64;
const JOB_KEEP_MS = 60 * 60 * 1000;

function pruneJobs(reserve = 0) {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.endedAt !== null && now - job.endedAt > JOB_KEEP_MS) JOBS.delete(id);
  }
  if (JOBS.size + reserve > MAX_JOBS) {
    const finished = [...JOBS.values()]
      .filter((job) => job.endedAt !== null)
      .sort((a, b) => a.endedAt - b.endedAt);
    for (const job of finished.slice(0, JOBS.size + reserve - MAX_JOBS)) JOBS.delete(job.id);
  }
}

/** 每条流单独计入 max-output 配额，超出后只标记截断、不再增长内存。 */
function appendJobOutput(job, stream, chunk) {
  const used = stream === "stdout" ? job.stdoutBytes : job.stderrBytes;
  if (used >= MAX_OUTPUT) {
    job.truncated = true;
    return;
  }
  const room = MAX_OUTPUT - used;
  const slice = chunk.subarray(0, Math.min(chunk.length, room));
  job[stream].push(slice);
  if (stream === "stdout") job.stdoutBytes += slice.length;
  else job.stderrBytes += slice.length;
  if (chunk.length > room) job.truncated = true;
}

function jobMeta(job) {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd || null,
    running: job.endedAt === null,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    truncated: job.truncated,
  };
}

function jobOutput(job) {
  return {
    ...jobMeta(job),
    stdout: decodeOutput(Buffer.concat(job.stdout)),
    stderr: decodeOutput(Buffer.concat(job.stderr)),
  };
}

function finishJob(job, code, signal, timedOut) {
  if (job.endedAt !== null) return;
  job.endedAt = Date.now();
  job.exitCode = code;
  job.signal = signal;
  job.timedOut = Boolean(timedOut);
  job.child = null;
  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }
}

function startJob(payload = {}) {
  const command = payload.command;
  if (typeof command !== "string" || !command.trim()) {
    throw new HttpError(400, "BAD_COMMAND", "缺少 command 参数");
  }
  const spawnCwd = resolveSpawnCwd(payload.cwd);
  const spawnEnv = { ...process.env };
  if (payload.env && typeof payload.env === "object") {
    for (const [key, value] of Object.entries(payload.env)) spawnEnv[key] = String(value);
  }
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  // 后台任务默认不限时（构建设计如此），显式 timeoutMs 时仍受 max-exec-timeout 约束。
  const timeout = Number.isInteger(payload.timeoutMs) && payload.timeoutMs > 0
    ? Math.min(payload.timeoutMs, MAX_EXEC_TIMEOUT)
    : 0;

  pruneJobs(1);
  if (JOBS.size >= MAX_JOBS) {
    throw new HttpError(429, "JOB_LIMIT", `后台任务已满（最多 ${MAX_JOBS} 个），请先结束运行中的任务`);
  }
  const job = {
    id: `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    command,
    cwd: spawnCwd,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    child: null,
    timer: null,
  };

  const child = spawn(shell, shellArgs, {
    cwd: spawnCwd,
    env: spawnEnv,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  JOBS.set(job.id, job);

  child.stdout.on("data", (chunk) => appendJobOutput(job, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendJobOutput(job, "stderr", chunk));
  child.on("error", (error) => {
    appendJobOutput(job, "stderr", Buffer.from(`启动命令失败: ${error.message}\n`, "utf8"));
    finishJob(job, null, null, job.timedOut);
  });
  child.on("close", (code, signal) => finishJob(job, code, signal, job.timedOut));

  if (timeout > 0) {
    job.timer = setTimeout(() => {
      job.timedOut = true;
      killTree(child);
    }, timeout);
    job.timer.unref?.();
  }

  return jobMeta(job);
}

function findJob(id) {
  const job = JOBS.get(String(id ?? "").trim());
  if (!job) throw new HttpError(404, "JOB_NOT_FOUND", `后台任务不存在: ${id}`);
  return job;
}

function listJobs() {
  pruneJobs();
  return [...JOBS.values()].sort((a, b) => b.startedAt - a.startedAt).map(jobMeta);
}

function killJob(id) {
  const job = findJob(id);
  if (job.endedAt !== null) return { id: job.id, killed: false, message: "任务已结束" };
  if (job.child) killTree(job.child);
  return { id: job.id, killed: true, message: "已发送结束信号（包含整个进程树）" };
}

// ── 各端点实现 ──────────────────────────────────────────────────────────────
function sysinfo() {
  const mem = (n) => Number(n) || 0;
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    osType: os.type(),
    arch: os.arch(),
    release: os.release(),
    uptimeSec: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: { model: os.cpus()[0]?.model || "unknown", count: os.cpus().length },
    memTotalBytes: mem(os.totalmem()),
    memFreeBytes: mem(os.freemem()),
    user: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "";
      }
    })(),
    homedir: os.homedir(),
    nodeVersion: process.version,
    agentVersion: VERSION,
    agentName: opts.name,
  };
}

function health() {
  return {
    ok: true,
    name: opts.name,
    version: VERSION,
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSec: Math.floor(os.uptime()),
    time: new Date().toISOString(),
    workspace: opts.workspace || null,
    runningJobs: [...JOBS.values()].filter((job) => job.endedAt === null).length,
    keepAwake: keepAwakeStatus.state === "active",
    keepAwakeStatus: { ...keepAwakeStatus },
  };
}

async function fsOperation(payload) {
  const op = payload.op;
  if (typeof op !== "string") throw new HttpError(400, "BAD_OP", "缺少 op 参数");
  const target = resolvePath(payload.path);

  switch (op) {
    case "list": {
      let entries;
      try {
        entries = await fs.promises.readdir(target, { withFileTypes: true });
      } catch {
        const st = await fs.promises.stat(target);
        if (st.isFile()) {
          return [{ name: path.basename(target), type: "file", sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) }];
        }
        throw new HttpError(400, "NOT_DIR", `无法列出目录: ${target}`);
      }
      const list = entries
        .map((entry) => {
          let type = "other";
          if (entry.isFile()) type = "file";
          else if (entry.isDirectory()) type = "directory";
          return { name: entry.name, type };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
      for (const item of list) {
        try {
          const st = await fs.promises.stat(path.join(target, item.name));
          item.sizeBytes = st.size;
          item.mtimeMs = Math.round(st.mtimeMs);
        } catch {
          // 无权限/已消失：保留基本信息。
        }
      }
      return list;
    }
    case "stat": {
      const st = await fs.promises.stat(target);
      return {
        path: target,
        exists: true,
        type: st.isFile() ? "file" : st.isDirectory() ? "directory" : "other",
        sizeBytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        birthtimeMs: Math.round(st.birthtimeMs),
        mode: st.mode,
      };
    }
    case "read": {
      const st = await fs.promises.stat(target);
      if (!st.isFile()) throw new HttpError(400, "NOT_FILE", `不是文件: ${target}`);
      const encoding = payload.encoding === "base64" ? "base64" : "utf8";
      const truncated = st.size > MAX_OUTPUT;
      const buf = truncated
        ? await fs.promises.open(target, "r").then(async (fh) => {
            const b = Buffer.alloc(MAX_OUTPUT);
            await fh.read(b, 0, MAX_OUTPUT, 0);
            await fh.close();
            return b;
          })
        : await fs.promises.readFile(target);
      return {
        path: target,
        encoding,
        sizeBytes: st.size,
        content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"),
        truncated,
      };
    }
    case "write":
    case "append": {
      const encoding = payload.encoding === "base64" ? "base64" : "utf8";
      let buf;
      if (payload.data !== undefined) {
        buf = Buffer.from(String(payload.data), "base64");
      } else if (typeof payload.content === "string") {
        buf = encoding === "base64" ? Buffer.from(payload.content, "base64") : Buffer.from(payload.content, "utf8");
      } else {
        throw new HttpError(400, "BAD_CONTENT", "write/append 需要 content 或 data(base64) 字段");
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (op === "write") await fs.promises.writeFile(target, buf);
      else await fs.promises.appendFile(target, buf);
      return { op, path: target, sizeBytes: buf.length };
    }
    case "mkdir":
      await fs.promises.mkdir(target, { recursive: payload.recursive === true });
      return { op, path: target, created: true };
    case "delete": {
      guardDestructiveDelete(target);
      await fs.promises.rm(target, { recursive: payload.recursive === true, force: false });
      return { op, path: target, deleted: true };
    }
    case "rename": {
      if (typeof payload.newPath !== "string" || !payload.newPath) {
        throw new HttpError(400, "BAD_NEW_PATH", "rename 需要 newPath 字段");
      }
      const newTarget = resolvePath(payload.newPath);
      await fs.promises.rename(target, newTarget);
      return { op, path: target, newPath: newTarget, renamed: true };
    }
    default:
      throw new HttpError(400, "BAD_OP", `不支持的 op: ${op}（支持 list/stat/read/write/append/mkdir/delete/rename）`);
  }
}

async function processList() {
  const command = process.platform === "win32" ? "tasklist /FO CSV /NH" : "ps -eo pid=,ppid=,args=";
  const result = await runCommand(command, { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new HttpError(500, "PROCESS_LIST_FAILED", result.stderr || "进程列表命令失败");
  }
  if (process.platform === "win32") {
    const rows = [];
    const re = /^"([^"]*)"\s*,\s*"(\d+)"\s*,\s*"[^"]*"\s*,\s*"\d+"\s*,\s*"([^"]*)"$/;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.trim().match(re);
      if (!match) continue;
      rows.push({ pid: Number(match[2]), name: match[1] || "unknown", cmd: `${match[1]} (${match[3]})` });
    }
    return rows;
  }
  const rows = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.indexOf(" ");
    if (first <= 0) continue;
    const pid = Number(trimmed.slice(0, first));
    let rest = trimmed.slice(first + 1).trim();
    const second = rest.indexOf(" ");
    let ppid;
    if (second > 0) {
      ppid = Number(rest.slice(0, second));
      rest = rest.slice(second + 1).trim();
    }
    const name = path.basename(rest.split(/\s+/)[0] || "");
    rows.push({ pid, ppid, name, cmd: rest });
  }
  return rows.filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

async function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new HttpError(400, "BAD_PID", "pid 必须是正整数");
  if (process.platform === "win32") {
    const result = await runCommand(`taskkill /pid ${pid} /T /F`, { timeoutMs: 15_000 });
    return {
      pid,
      killed: result.exitCode === 0,
      message: result.stdout.trim() || result.stderr.trim() || `taskkill 退出码 ${result.exitCode}`,
    };
  }
  try {
    process.kill(pid, "SIGTERM");
    return { pid, killed: true, message: `已向 pid ${pid} 发送 SIGTERM` };
  } catch (error) {
    return { pid, killed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function handleUpload(req, res, url) {
  const rawPath = url.searchParams.get("path");
  let tmp;
  let size = 0;
  let limiter;
  let out;
  let requestError;
  const onRequestError = (error) => {
    requestError = error;
    limiter?.destroy(error);
  };
  const onAborted = () => onRequestError(new HttpError(400, "UPLOAD_ABORTED", "上传连接已断开"));
  req.on("error", onRequestError);
  req.once("aborted", onAborted);
  try {
    const target = resolvePath(rawPath);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      throw new HttpError(400, "NOT_FILE", `上传目标是目录: ${target}`);
    }
    if (req.aborted) onAborted();
    if (requestError) throw requestError;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    resolvePath(rawPath); // Recheck ancestors after creating directories.
    if (requestError) throw requestError;
    tmp = `${target}.part-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_UPLOAD) callback(new HttpError(413, "UPLOAD_TOO_LARGE", `上传超过上限 ${MAX_UPLOAD} 字节`));
        else callback(null, chunk);
      },
    });
    out = fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
    // Keep the request socket out of pipeline's destroy-on-error chain so a
    // quota/write failure can still return a structured HTTP error to the client.
    const transfer = pipeline(limiter, out);
    req.pipe(limiter);
    await transfer;
    if (requestError || req.aborted) throw requestError || new HttpError(400, "UPLOAD_ABORTED", "上传连接已断开");
    resolvePath(rawPath); // Refuse replacement if the destination became a link outside root.
    await fs.promises.rename(tmp, target);
    tmp = undefined;
    ok(res, { path: target, sizeBytes: size });
  } catch (error) {
    if (!req.destroyed) {
      if (limiter) req.unpipe(limiter);
      req.resume();
    }
    if (!res.destroyed && !res.headersSent) {
      failResponse(res, error.status || 500, error.code || "UPLOAD_WRITE_FAILED", error.message);
    }
  } finally {
    req.removeListener("aborted", onAborted);
    // Keep an error observer while a rejected upload is draining to avoid an
    // unhandled socket error after the HTTP response has already been sent.
    if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

async function handleDownload(req, res, url) {
  const rawPath = url.searchParams.get("path");
  let target;
  try {
    target = resolvePath(rawPath);
  } catch (error) {
    failResponse(res, error.status || 400, error.code || "BAD_PATH", error.message);
    return;
  }
  try {
    const st = await fs.promises.stat(target);
    if (!st.isFile()) throw new HttpError(400, "NOT_FILE", `不是文件: ${target}`);
    const name = encodeURIComponent(path.basename(target));
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": st.size,
      "content-disposition": `attachment; filename*=UTF-8''${name}`,
      "x-dsh-file-name": encodeURIComponent(path.basename(target)),
      "x-dsh-file-size": String(st.size),
    });
    const stream = fs.createReadStream(target);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    if (error instanceof HttpError) {
      failResponse(res, error.status, error.code, error.message);
    } else {
      failResponse(res, 500, "DOWNLOAD_FAILED", `下载失败: ${error.message}`);
    }
  }
}

// ── 路由 ────────────────────────────────────────────────────────────────────
async function route(req, res, url) {
  const method = req.method || "GET";
  const pathname = url.pathname;

  if (!authorized(req)) {
    failResponse(res, 401, "UNAUTHORIZED", "token 缺失或不正确（Authorization: Bearer <token>）");
    return;
  }

  try {
    if (pathname === "/health" || pathname === "/") {
      if (method !== "GET") return failResponse(res, 405, "METHOD", "仅支持 GET");
      return ok(res, health());
    }
    if (pathname === "/sysinfo") {
      if (method !== "GET") return failResponse(res, 405, "METHOD", "仅支持 GET");
      return ok(res, sysinfo());
    }
    if (pathname === "/exec") {
      if (method !== "POST") return failResponse(res, 405, "METHOD", "仅支持 POST");
      const payload = await readJson(req);
      return ok(res, await runCommand(payload.command, payload));
    }
    if (pathname === "/fs") {
      if (method !== "POST") return failResponse(res, 405, "METHOD", "仅支持 POST");
      const payload = await readJson(req);
      return ok(res, await fsOperation(payload));
    }
    if (pathname === "/upload") {
      if (method !== "POST") return failResponse(res, 405, "METHOD", "仅支持 POST");
      return handleUpload(req, res, url);
    }
    if (pathname === "/download") {
      if (method !== "GET") return failResponse(res, 405, "METHOD", "仅支持 GET");
      return handleDownload(req, res, url);
    }
    if (pathname === "/processes") {
      if (method !== "GET") return failResponse(res, 405, "METHOD", "仅支持 GET");
      return ok(res, await processList());
    }
    if (pathname === "/process/kill") {
      if (method !== "POST") return failResponse(res, 405, "METHOD", "仅支持 POST");
      const payload = await readJson(req);
      return ok(res, await killProcess(payload.pid));
    }
    if (pathname === "/job/start") {
      if (method !== "POST") return failResponse(res, 405, "METHOD", "仅支持 POST");
      return ok(res, startJob(await readJson(req)));
    }
    if (pathname === "/job/list") {
      if (method !== "GET") return failResponse(res, 405, "METHOD", "仅支持 GET");
      return ok(res, listJobs());
    }
    if (pathname === "/job/output") {
      if (method !== "GET") return failResponse(res, 405, "METHOD", "仅支持 GET");
      return ok(res, jobOutput(findJob(url.searchParams.get("id"))));
    }
    if (pathname === "/job/kill") {
      if (method !== "POST") return failResponse(res, 405, "METHOD", "仅支持 POST");
      const payload = await readJson(req);
      return ok(res, killJob(payload.id));
    }
    failResponse(res, 404, "NOT_FOUND", `未知端点: ${method} ${pathname}`);
  } catch (error) {
    if (error instanceof HttpError) {
      failResponse(res, error.status, error.code, error.message);
    } else {
      failResponse(res, 500, "INTERNAL", error instanceof Error ? error.message : String(error));
    }
  }
}

// ── 反向隧道（reverse connect）：目标机主动回连 harness 网关 ──────────────────
let reverseTarget = null;
if (opts.reverse) {
  const match = /^(.+):(\d+)$/.exec(String(opts.reverse).trim());
  if (!match || !Number.isInteger(Number(match[2])) || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    fail(`--reverse 格式应为 host:port（收到 ${opts.reverse}）`);
  }
  reverseTarget = { host: match[1], port: Number(match[2]) };
}

function reverseHandshakeLine() {
  return `DSH-REV1 ${opts.token || opts.tokenSha256} ${opts.port}\n`;
}

/** 把一条已配对的反向隧道接到本机 agent HTTP，双向泵送原始字节。
 *  firstChunk 已剥离协议首字节（GO），但可能是空 buffer（请求字节随后才到），
 *  因此在 http 连接就绪前用临时 data 监听器兜住后续字节。 */
function pairWithLocalAgent(tunnel, firstChunk) {
  const httpSocket = net.connect(opts.port, "127.0.0.1");
  httpSocket.setNoDelay(true);
  let paired = false;
  const pending = [];
  if (firstChunk && firstChunk.length > 0) pending.push(firstChunk);
  // 本地 HTTP 连接建立前收到的分片先缓冲，绝不丢弃。
  const onTunnelData = (chunk) => {
    if (httpSocket.readyState === "open") httpSocket.write(chunk);
    else pending.push(chunk);
  };
  tunnel.on("data", onTunnelData);
  const teardown = () => {
    tunnel.destroy();
    httpSocket.destroy();
  };
  httpSocket.on("connect", () => {
    paired = true;
    tunnel.removeListener("data", onTunnelData);
    for (const chunk of pending) httpSocket.write(chunk);
    pending.length = 0;
    tunnel.pipe(httpSocket);
    httpSocket.pipe(tunnel);
  });
  httpSocket.on("error", teardown);
  httpSocket.on("close", () => {
    if (!paired) tunnel.destroy();
  });
  tunnel.on("error", teardown);
}

/** 维护一条反向隧道连接：握手 → 进池等待（心跳保活）→ 配对泵送 → 断开自动重连。
 *  空闲心跳：网关每 30s 发 0x00 PING，agent 回 0x00 PONG；90s 无任何字节视为死链，
 *  主动断开重连。TCP keepalive 兜底对抗 NAT/中间设备静默丢包。 */
function maintainReverseTunnel(backoffMs = 2000) {
  if (!reverseTarget) return;
  const socket = net.connect(reverseTarget.port, reverseTarget.host);
  let idle = false;
  let idleTimer = null;
  let backoff = backoffMs;
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdleTimer = () => {
    clearIdleTimer();
    if (idle) {
      idleTimer = setTimeout(() => {
        // 空闲期长时间无任何字节：链路大概率已死（半开），主动断开触发重连。
        socket.destroy();
      }, 90_000).unref();
    }
  };
  const scheduleReconnect = () => {
    clearIdleTimer();
    setTimeout(() => maintainReverseTunnel(Math.min(backoff * 2, 15_000)), backoff).unref();
  };

  socket.on("connect", () => {
    backoff = 2000; // 连接成功即复位退避。
    socket.write(reverseHandshakeLine());
    idle = true;
    resetIdleTimer();
  });
  socket.on("data", (chunk) => {
    if (!idle) return;
    while (idle && chunk.length > 0) {
      const cmd = chunk[0];
      if (cmd === 0x00) {
        // PING → PONG，保持空闲。
        socket.write(Buffer.from([0x00]));
        chunk = chunk.subarray(1);
        resetIdleTimer();
        continue;
      }
      // 0x01 GO（或异常数据）→ 进入配对，剥离首字节后把剩余字节交给本地 agent。
      idle = false;
      clearIdleTimer();
      socket.removeAllListeners("data");
      pairWithLocalAgent(socket, chunk.subarray(1));
      return;
    }
  });
  socket.on("close", scheduleReconnect);
  socket.on("error", () => socket.destroy());
}

function startReversePool() {
  if (!reverseTarget) return;
  for (let i = 0; i < opts.reversePool; i++) maintainReverseTunnel();
  console.log(`  反向隧道: 回连 ${reverseTarget.host}:${reverseTarget.port}（连接池 ${opts.reversePool}，自动重连）`);
}

// ── 服务启动 ────────────────────────────────────────────────────────────────
const useTls = Boolean(opts.cert && opts.key);
let server;
if (useTls) {
  try {
    server = https.createServer({
      cert: fs.readFileSync(opts.cert),
      key: fs.readFileSync(opts.key),
    }, (req, res) => {
      void route(req, res, new URL(req.url || "/", "http://agent.local")).catch(() => res.destroy());
    });
  } catch (error) {
    fail(`读取 TLS 证书失败: ${error.message}`);
  }
} else {
  server = http.createServer((req, res) => {
    void route(req, res, new URL(req.url || "/", "http://agent.local")).catch(() => res.destroy());
  });
}

server.on("error", (error) => {
  console.error(`[dsh-remote-agent] 监听失败: ${error.message}`);
  process.exit(1);
});

// 放宽 HTTP 空闲连接参数：减少控制器侧长连接被 5s keepAliveTimeout 频繁回收。
server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;

server.listen(opts.port, opts.host, () => {
  console.log(`[dsh-remote-agent v${VERSION}] 已启动: ${useTls ? "https" : "http"}://${opts.host}:${opts.port}`);
  console.log(`  名称: ${opts.name}  主机: ${os.hostname()}  平台: ${os.platform()}/${os.arch()}`);
  if (tokenGenerated) {
    console.log(`  token 已自动生成（同时写入 ${path.join(SCRIPT_DIR, "agent-token.txt")}）:`);
    console.log(`    ${opts.token}`);
  } else if (opts.token) {
    console.log(`  token: 使用 --token 提供的值（前缀 ${opts.token.slice(0, 6)}…）`);
  } else {
    console.log(`  token: 使用 --token-sha256（${opts.tokenSha256.slice(0, 8)}…）`);
  }
  if (opts.root) console.log(`  文件 API 路径范围（不限制 shell 命令）: ${path.resolve(opts.root)}`);
  startKeepAwake();
  startReversePool();
  console.log("  按 Ctrl+C 停止。");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n[dsh-remote-agent] 收到 ${signal}，正在退出…`);
    stopKeepAwake();
    for (const job of JOBS.values()) {
      if (job.endedAt === null && job.child) killTree(job.child);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
