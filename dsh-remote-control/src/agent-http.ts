/**
 * Controller-side HTTP client for dsh-remote-agent.
 *
 * Wire protocol (JSON over HTTP, Bearer/X-DSH-Token auth):
 *   GET  /health                    -> { ok, name, version, hostname, ... }
 *   GET  /sysinfo                   -> { osType, platform, arch, ... }
 *   POST /exec                      -> { command, cwd?, env?, timeoutMs? }
 *   POST /fs                        -> { op, path, ... }
 *   POST /upload?path=...           -> octet-stream body
 *   GET  /download?path=...         -> octet-stream response
 *   GET  /processes                 -> [{ pid, name, cmd }]
 *   POST /process/kill              -> { pid }
 *   POST /job/start                 -> job metadata (long-running command)
 *   GET  /job/list                  -> [job metadata]
 *   GET  /job/output?id=...         -> job metadata + stdout/stderr
 *   POST /job/kill                  -> { id, killed, message }
 *
 * Every JSON response is enveloped: `{ ok: true, data }` on success and
 * `{ ok: false, error: { code, message } }` on failure.
 *
 * A machine may declare several paths (direct + reverse tunnel). Requests try
 * them in order; only connection-level failures (nothing was sent) trigger a
 * fallback to the next path — timeouts never retry because the remote side may
 * already have executed the command.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RemoteMachine, RemotePath } from "./registry.js";
import { normalizeTunnelUrl } from "./registry.js";

export class RemoteAgentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "REMOTE_ERROR", status = 0) {
    super(message);
    this.name = "RemoteAgentError";
    this.code = code;
    this.status = status;
  }
}

/** Only locally observed, pre-response connection failures may trigger path fallback. */
class PreconnectAgentError extends RemoteAgentError {}

export interface ExecResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface SysInfo {
  hostname: string;
  platform: string;
  osType: string;
  arch: string;
  release: string;
  uptimeSec: number;
  loadAvg: number[];
  cpus: { model: string; count: number };
  memTotalBytes: number;
  memFreeBytes: number;
  user: string;
  homedir: string;
  nodeVersion: string;
  agentVersion: string;
  agentName: string;
}

export interface ProcessInfo {
  pid: number;
  ppid?: number;
  name: string;
  cmd?: string;
}

/** Background job started through /job/start (long commands that outlive a request). */
export interface JobInfo {
  id: string;
  command: string;
  cwd: string | null;
  running: boolean;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

/** Job metadata plus the output captured so far. */
export interface JobOutput extends JobInfo {
  stdout: string;
  stderr: string;
}

export interface FsEntry {
  name: string;
  type: "file" | "directory" | "other";
  sizeBytes: number;
  mtimeMs: number;
}

export interface FsStat {
  path: string;
  exists: boolean;
  type?: "file" | "directory" | "other";
  sizeBytes?: number;
  mtimeMs?: number;
  birthtimeMs?: number;
  mode?: number;
}

export interface FsReadResult {
  path: string;
  encoding: "utf8" | "base64";
  sizeBytes: number;
  content: string;
  truncated: boolean;
}

export interface FsWriteResult {
  path: string;
  sizeBytes: number;
  op: string;
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  version: string;
  hostname: string;
  platform: string;
  uptimeSec: number;
  time: string;
  workspace?: string | null;
  runningJobs?: number;
  keepAwake?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface TransferOptions {
  timeoutMs?: number;
}

interface AgentEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Codes that mean "nothing reached the agent", safe to retry on next path. */
const SAFE_RETRY_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/**
 * Conservative synchronous timeout for public tunnels. Provider/plan limits vary.
 * Prefer a structured agent timeout over an ambiguous edge timeout.
 */
export const TUNNEL_EXEC_TIMEOUT_MS = 90_000;
/** Conservative upload threshold; actual provider/plan limits vary. */
export const TUNNEL_UPLOAD_LIMIT_BYTES = 95 * 1024 * 1024;

/** Ordered paths: public tunnel first (when configured), then registered direct/reverse paths. */
function machinePaths(machine: RemoteMachine): RemotePath[] {
  const paths: RemotePath[] = [];
  const tunnel = normalizeTunnelUrl(machine.tunnelUrl);
  if (tunnel) {
    try {
      paths.push({ kind: "tunnel", host: new URL(tunnel).host, port: 443, url: tunnel });
    } catch {
      // normalizeTunnelUrl already validated; ignore defensive failure.
    }
  }
  if (machine.paths && machine.paths.length > 0) paths.push(...machine.paths);
  else paths.push({ kind: "direct", host: machine.host, port: machine.port });
  return paths;
}

function authHeaders(machine: RemoteMachine): Record<string, string> {
  const headers: Record<string, string> = {};
  if (machine.token) headers["Authorization"] = `Bearer ${machine.token}`;
  else if (machine.tokenSha256) headers["X-DSH-Token"] = machine.tokenSha256;
  return headers;
}

function machineLabel(machine: RemoteMachine): string {
  return `${machine.name || machine.id} (${machine.host}:${machine.port})`;
}

function pathLabel(machine: RemoteMachine, p: RemotePath): string {
  const prefix = p.kind === "reverse" ? "反向隧道 " : p.kind === "tunnel" ? "公网隧道 " : "";
  if (p.kind === "tunnel") return `${machine.name || machine.id} (${prefix}${p.url ?? p.host})`;
  return `${machine.name || machine.id} (${prefix}${p.host}:${p.port})`;
}

function endpoint(p: RemotePath, pathname: string): string {
  if (p.kind === "tunnel") {
    const base = p.url && !p.url.endsWith("/") ? `${p.url}/` : p.url;
    return new URL(pathname.replace(/^\//, ""), base).toString();
  }
  const hostPart = p.host.includes(":") && !p.host.startsWith("[") ? `[${p.host}]` : p.host;
  return `http://${hostPart}:${p.port}${pathname}`;
}

/** undici 会把 ECONNREFUSED 包在 cause / AggregateError.errors 里，递归取出来。 */
function extractErrno(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const record = cause as NodeJS.ErrnoException & { cause?: unknown; errors?: unknown[] };
  if (typeof record.code === "string" && record.code) return record.code;
  if (typeof record.errno === "string" && record.errno) return record.errno;
  if (record.cause) {
    const code = extractErrno(record.cause);
    if (code) return code;
  }
  for (const item of record.errors ?? []) {
    const code = extractErrno(item);
    if (code) return code;
  }
  return undefined;
}

/** Client for one remote agent. All methods throw RemoteAgentError. */
export class RemoteClient {
  readonly machine: RemoteMachine;
  readonly defaultTimeoutMs: number;

  constructor(machine: RemoteMachine, defaultTimeoutMs = 120_000) {
    if (machine.enabled === false) {
      throw new RemoteAgentError(`机器 "${machine.id}" 已停用，拒绝远程请求。`, "MACHINE_DISABLED");
    }
    this.machine = machine;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Keep the deadline alive until the response body has been consumed/written. */
  private async fetchVia<T>(
    p: RemotePath,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.machine.enabled === false) {
      throw new RemoteAgentError(`机器 "${this.machine.id}" 已停用，拒绝远程请求。`, "MACHINE_DISABLED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      // A redirect can change the credential destination or replay a POST. Never follow it.
      response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new RemoteAgentError(
          `agent ${pathLabel(this.machine, p)} 返回重定向（HTTP ${response.status}），为防止凭据转发或重复执行已拒绝。`,
          "REDIRECT_REJECTED",
          response.status,
        );
      }
      const value = await consume(response, controller.signal);
      controller.signal.throwIfAborted();
      return value;
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new RemoteAgentError(
          `连接 ${pathLabel(this.machine, p)} 超时（${timeoutMs}ms，包含响应正文传输）`,
          "TIMEOUT",
          0,
        );
      }
      if (cause instanceof RemoteAgentError) throw cause;
      const errno = extractErrno(cause);
      const message = `${response ? "读取响应失败" : "无法连接"} ${pathLabel(this.machine, p)}：${cause instanceof Error ? cause.message : String(cause)}`;
      // Neither body failures nor remote error envelopes are pre-connect evidence.
      if (!response && errno && SAFE_RETRY_CODES.has(errno)) {
        throw new PreconnectAgentError(message, errno, 0);
      }
      throw new RemoteAgentError(message, errno ?? "NETWORK", response?.status ?? 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private retryable(error: unknown): boolean {
    return error instanceof PreconnectAgentError && error.status === 0 && SAFE_RETRY_CODES.has(error.code);
  }

  /** JSON request with per-path fallback (connection errors only). */
  async request<T>(method: string, pathname: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const paths = machinePaths(this.machine);
    let lastError: unknown;
    for (let i = 0; i < paths.length; i++) {
      try {
        return await this.fetchVia(
          paths[i],
          endpoint(paths[i], pathname),
          {
            method,
            headers: { ...authHeaders(this.machine), "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          timeoutMs ?? this.defaultTimeoutMs,
          async (res) => {
            const text = await res.text();
            let envelope: AgentEnvelope<T>;
            try {
              envelope = JSON.parse(text) as AgentEnvelope<T>;
            } catch {
              throw new RemoteAgentError(
                `agent ${pathLabel(this.machine, paths[i])} 返回了非 JSON 响应（HTTP ${res.status}）`,
                "BAD_RESPONSE",
                res.status,
              );
            }
            if (!res.ok || envelope.ok !== true) {
              const message = envelope.error?.message || `agent 请求失败（HTTP ${res.status}）`;
              throw new RemoteAgentError(message, envelope.error?.code || "AGENT_ERROR", res.status);
            }
            return envelope.data as T;
          },
        );
      } catch (error) {
        lastError = error;
        if (!this.retryable(error) || i === paths.length - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new RemoteAgentError(String(lastError));
  }

  async health(timeoutMs = 5000): Promise<HealthInfo> {
    return this.request<HealthInfo>("GET", "/health", undefined, timeoutMs);
  }

  async sysinfo(timeoutMs?: number): Promise<SysInfo> {
    return this.request<SysInfo>("GET", "/sysinfo", undefined, timeoutMs);
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const effective = this.effectiveExecTimeout(options.timeoutMs);
    const tunneled = Boolean(normalizeTunnelUrl(this.machine.tunnelUrl));
    const requestTimeout = tunneled
      ? Math.min(effective + 5_000, TUNNEL_EXEC_TIMEOUT_MS + 5_000)
      : effective + 10_000;
    return this.request<ExecResult>("POST", "/exec", {
      command,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: effective,
    }, requestTimeout);
  }

  /** Public tunnels cap one HTTP exchange at ~100s, so the agent timeout stays below it. */
  effectiveExecTimeout(requested?: number): number {
    const wanted = requested ?? this.defaultTimeoutMs;
    return normalizeTunnelUrl(this.machine.tunnelUrl) ? Math.min(wanted, TUNNEL_EXEC_TIMEOUT_MS) : wanted;
  }

  async fs(op: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request("POST", "/fs", { op, ...payload }, timeoutMs);
  }

  /** Upload a local file to the remote machine as raw octets. */
  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<FsWriteResult> {
    const data = await readFile(localPath);
    if (normalizeTunnelUrl(this.machine.tunnelUrl) && data.byteLength > TUNNEL_UPLOAD_LIMIT_BYTES) {
      throw new RemoteAgentError(
        `已超过插件为公网隧道设置的 95 MiB 保守上传阈值，当前文件 ${(data.byteLength / 1024 / 1024).toFixed(1)}MB。` +
        `请先压缩/分卷，或改用直连/VPN 上传；下载不受此限制。`,
        "TUNNEL_UPLOAD_LIMIT",
      );
    }
    const paths = machinePaths(this.machine);
    let lastError: unknown;
    for (let i = 0; i < paths.length; i++) {
      try {
        return await this.fetchVia(
          paths[i],
          `${endpoint(paths[i], "/upload")}?path=${encodeURIComponent(remotePath)}`,
          {
            method: "POST",
            headers: {
              ...authHeaders(this.machine),
              "content-type": "application/octet-stream",
              "x-dsh-file-size": String(data.byteLength),
            },
            body: new Uint8Array(data),
          },
          options.timeoutMs ?? this.defaultTimeoutMs,
          async (res) => {
            const text = await res.text();
            let envelope: AgentEnvelope<FsWriteResult>;
            try {
              envelope = JSON.parse(text) as AgentEnvelope<FsWriteResult>;
            } catch {
              throw new RemoteAgentError(`agent 上传响应异常（HTTP ${res.status}）`, "BAD_RESPONSE", res.status);
            }
            if (!res.ok || envelope.ok !== true) {
              throw new RemoteAgentError(
                envelope.error?.message || `上传失败（HTTP ${res.status}）`,
                envelope.error?.code || "AGENT_ERROR",
                res.status,
              );
            }
            return envelope.data as FsWriteResult;
          },
        );
      } catch (error) {
        lastError = error;
        if (!this.retryable(error) || i === paths.length - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new RemoteAgentError(String(lastError));
  }

  /** Download a remote file into a local path (created atomically). */
  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<{ localPath: string; sizeBytes: number }> {
    const paths = machinePaths(this.machine);
    let lastError: unknown;
    for (let i = 0; i < paths.length; i++) {
      try {
        return await this.fetchVia(
          paths[i],
          `${endpoint(paths[i], "/download")}?path=${encodeURIComponent(remotePath)}`,
          { method: "GET", headers: { ...authHeaders(this.machine) } },
          options.timeoutMs ?? this.defaultTimeoutMs,
          async (res, signal) => {
            if (!res.ok) {
              const text = await res.text();
              let message = `下载失败（HTTP ${res.status}）`;
              try {
                const envelope = JSON.parse(text) as AgentEnvelope<never>;
                message = envelope.error?.message || message;
              } catch {
                // keep default message
              }
              throw new RemoteAgentError(message, "DOWNLOAD_FAILED", res.status);
            }
            if (!res.body) throw new RemoteAgentError("下载响应缺少正文。", "BAD_RESPONSE", res.status);
            await mkdir(dirname(localPath), { recursive: true });
            const tmp = `${localPath}.part-${randomUUID()}`;
            let sizeBytes = 0;
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                sizeBytes += chunk.length;
                callback(null, chunk);
              },
            });
            try {
              await pipeline(
                Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
                counter,
                createWriteStream(tmp, { flags: "wx" }),
                { signal },
              );
              signal.throwIfAborted();
              await rename(tmp, localPath);
              return { localPath, sizeBytes };
            } finally {
              // Failed/aborted transfers must not replace the destination or leave .part files.
              await rm(tmp, { force: true });
            }
          },
        );
      } catch (error) {
        lastError = error;
        if (!this.retryable(error) || i === paths.length - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new RemoteAgentError(String(lastError));
  }

  async processes(timeoutMs?: number): Promise<ProcessInfo[]> {
    return this.request<ProcessInfo[]>("GET", "/processes", undefined, timeoutMs);
  }

  async killProcess(pid: number, timeoutMs?: number): Promise<{ pid: number; killed: boolean; message: string }> {
    return this.request("POST", "/process/kill", { pid }, timeoutMs);
  }

  /** Start a long-running command in the background; returns immediately with a job id. */
  async startJob(command: string, options: ExecOptions = {}): Promise<JobInfo> {
    return this.request<JobInfo>("POST", "/job/start", {
      command,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
  }

  async listJobs(timeoutMs?: number): Promise<JobInfo[]> {
    return this.request<JobInfo[]>("GET", "/job/list", undefined, timeoutMs);
  }

  async jobOutput(id: string, timeoutMs?: number): Promise<JobOutput> {
    return this.request<JobOutput>("GET", `/job/output?id=${encodeURIComponent(id)}`, undefined, timeoutMs);
  }

  async killJob(id: string, timeoutMs?: number): Promise<{ id: string; killed: boolean; message: string }> {
    return this.request("POST", "/job/kill", { id }, timeoutMs);
  }
}

export { machineLabel };
