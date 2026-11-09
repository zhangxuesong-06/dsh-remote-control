/**
 * Unified execution backend: the same operations over either transport.
 *
 * - 'ssh'   : no agent required. Runs commands/reads files through the target's
 *             own OpenSSH server (key auth). This is the default when no agent
 *             is installed.
 * - 'agent' : the optional HTTP agent (faster, background jobs).
 *
 * Tool handlers call this interface instead of RemoteClient directly, so a
 * machine works the moment it is reachable over SSH, with no agent present.
 */
import { RemoteClient, type ExecResult, type FsEntry, type FsStat, type SysInfo, type HealthInfo } from "./agent-http.js";
import type { RemoteMachine } from "./registry.js";
import { scpDownload, scpUpload, sshProbe, sshShell, defaultKnownHostsFile, type SshTarget } from "./ssh.js";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface Executor {
  readonly machine: RemoteMachine;
  readonly transport: "ssh" | "agent";
  health(timeoutMs?: number): Promise<HealthInfo>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  fs(op: string, payload: Record<string, unknown>): Promise<unknown>;
  upload(localPath: string, remotePath: string): Promise<{ sizeBytes: number; localPath?: string }>;
  download(remotePath: string, localPath: string): Promise<{ sizeBytes: number; localPath?: string }>;
  sysinfo(): Promise<SysInfo>;
  processes(): Promise<Array<{ pid: number; name: string; cmd?: string }>>;
  killProcess(pid: number): Promise<{ pid: number; killed: boolean; message: string }>;
  /** Agent-only: background jobs. Undefined on SSH transport. */
  startJob?(command: string, options?: ExecOptions): Promise<import("./agent-http.js").JobInfo>;
  listJobs?(): Promise<import("./agent-http.js").JobInfo[]>;
  jobOutput?(id: string): Promise<import("./agent-http.js").JobOutput>;
  killJob?(id: string): Promise<{ id: string; killed: boolean; message: string }>;
}

/** True when the machine should be driven over SSH (no agent available). */
export function usesSsh(machine: RemoteMachine): boolean {
  if (machine.transport === "agent") return false;
  if (machine.transport === "ssh") return true;
  // Default: SSH when no agent token was ever issued for the machine.
  return !machine.token && !machine.tokenSha256;
}

export function sshTargetOf(machine: RemoteMachine, identityFile: string): SshTarget & { identityFile: string } {
  if (!machine.username) throw new Error(`机器 "${machine.id}" 使用 SSH 传输但未配置用户名（SSH 登录账号）。`);
  const idFile = machine.sshIdentityFile || identityFile;
  return {
    id: machine.id,
    host: machine.host,
    port: machine.sshPort && machine.sshPort > 0 ? machine.sshPort : 22,
    username: machine.username,
    identityFile: idFile,
    knownHostsFile: defaultKnownHostsFile(idFile),
  };
}

function toExecResult(command: string, r: { code: number; stdout: string; stderr: string; timedOut: boolean }, startMs: number): ExecResult {
  return {
    command,
    exitCode: r.timedOut ? null : r.code,
    signal: null,
    stdout: r.stdout,
    stderr: r.timedOut ? `${r.stderr}\n[命令超时，已在本地断开]` : r.stderr,
    durationMs: Date.now() - startMs,
    timedOut: r.timedOut,
    truncated: false,
  };
}

/** SSH-backed executor: interprets fs ops with POSIX tools on the target. */
export class SshExecutor implements Executor {
  readonly transport = "ssh" as const;
  constructor(readonly machine: RemoteMachine, private identityFile: string, private defaultTimeoutMs = 120_000) {}

  private target() { return sshTargetOf(this.machine, this.identityFile); }
  private run(argv: string[], opts: ExecOptions = {}) {
    return sshShell(this.target(), this.identityFile, argv.join(" "), { timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs, cwd: opts.cwd, env: opts.env });
  }

  async health(timeoutMs = 5_000): Promise<HealthInfo> {
    const probe = await sshProbe(this.target(), this.identityFile, timeoutMs);
    if (!probe.ok) throw new Error(probe.detail);
    const r = await sshShell(this.target(), this.identityFile, "uname -s 2>/dev/null || echo Windows", { timeoutMs });
    const platform = /windows/i.test(r.stdout) ? "win32" : /darwin/i.test(r.stdout) ? "darwin" : "linux";
    return {
      ok: true, name: this.machine.name, version: "ssh", hostname: this.machine.name || this.machine.host,
      platform, uptimeSec: 0, time: new Date().toISOString(),
      workspace: this.machine.workspace ?? null,
    } as HealthInfo;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const start = Date.now();
    const r = await sshShell(this.target(), this.identityFile, command, {
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      cwd: options.cwd,
      env: options.env,
    });
    return toExecResult(command, r, start);
  }

  async fs(op: string, payload: Record<string, unknown>): Promise<unknown> {
    const p = String(payload.path ?? "");
    const t = this.target();
    const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    if (op === "stat") {
      const r = await sshShell(t, this.identityFile, `if [ -d ${q(p)} ]; then echo DIR; elif [ -e ${q(p)} ]; then echo FILE; else echo NONE; fi`, { timeoutMs: 15_000 });
      const kind = r.stdout.trim();
      if (kind === "NONE") return { path: p, exists: false } as FsStat;
      return { path: p, exists: true, type: kind === "DIR" ? "directory" : "file" } as FsStat;
    }
    if (op === "list") {
      const r = await sshShell(t, this.identityFile, `ls -la ${q(p)} 2>/dev/null || ls -la ${q(p)}/`, { timeoutMs: 15_000 });
      const entries: FsEntry[] = [];
      for (const line of r.stdout.split(/\r?\n/).slice(1)) {
        const cols = line.split(/\s+/);
        if (cols.length < 9) continue;
        const name = cols.slice(8).join(" ");
        if (name === "." || name === "..") continue;
        const isDir = cols[0].startsWith("d");
        entries.push({ name, type: isDir ? "directory" : "file", sizeBytes: Number(cols[4]) || 0, mtimeMs: 0 });
      }
      return entries;
    }
    if (op === "read") {
      const r = await sshShell(t, this.identityFile, `cat ${q(p)}`, { timeoutMs: 30_000 });
      return { path: p, encoding: "utf8", sizeBytes: Buffer.byteLength(r.stdout), content: r.stdout, truncated: false };
    }
    if (op === "write" || op === "append") {
      const content = String(payload.content ?? "");
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const redir = op === "append" ? ">>" : ">";
      const r = await sshShell(t, this.identityFile, `printf %s ${q(b64)} | base64 -d ${redir} ${q(p)}`, { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(r.stderr || "写入失败");
      return { path: p, sizeBytes: Buffer.byteLength(content), op };
    }
    if (op === "mkdir") {
      const r = await sshShell(t, this.identityFile, `mkdir -p ${q(p)}`, { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(r.stderr || "mkdir 失败");
      return { path: p, op };
    }
    if (op === "delete") {
      const r = await sshShell(t, this.identityFile, `rm -rf ${q(p)}`, { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(r.stderr || "删除失败");
      return { path: p, op };
    }
    if (op === "rename") {
      const np = String(payload.newPath ?? "");
      const r = await sshShell(t, this.identityFile, `mv ${q(p)} ${q(np)}`, { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(r.stderr || "重命名失败");
      return { path: np, op };
    }
    throw new Error(`SSH 传输不支持该文件操作：${op}`);
  }

  async upload(localPath: string, remotePath: string): Promise<{ sizeBytes: number }> {
    const r = await scpUpload(this.target(), this.identityFile, localPath, remotePath);
    if (r.code !== 0) throw new Error(r.stderr || "上传失败");
    const { statSync } = await import("node:fs");
    return { sizeBytes: statSync(localPath).size };
  }

  async download(remotePath: string, localPath: string): Promise<{ sizeBytes: number }> {
    const { mkdirSync, statSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(localPath), { recursive: true });
    const r = await scpDownload(this.target(), this.identityFile, remotePath, localPath);
    if (r.code !== 0) throw new Error(r.stderr || "下载失败");
    return { sizeBytes: statSync(localPath).size };
  }

  async sysinfo(): Promise<SysInfo> {
    const t = this.target();
    const r = await sshShell(t, this.identityFile, "uname -a 2>/dev/null; uptime 2>/dev/null; nproc 2>/dev/null", { timeoutMs: 15_000 });
    return {
      hostname: this.machine.name || this.machine.host, platform: "linux", osType: (r.stdout.split(/\r?\n/)[0] || "unknown").slice(0, 100),
      arch: "", release: "", uptimeSec: 0, loadAvg: [], cpus: { model: "unknown", count: 0 },
      memTotalBytes: 0, memFreeBytes: 0, user: this.machine.username ?? "", homedir: "",
      nodeVersion: "", agentVersion: "ssh", agentName: this.machine.name,
    } as SysInfo;
  }

  async processes(): Promise<Array<{ pid: number; name: string; cmd?: string }>> {
    const r = await sshShell(this.target(), this.identityFile, "ps -eo pid,comm,args 2>/dev/null | head -200", { timeoutMs: 15_000 });
    const out: Array<{ pid: number; name: string; cmd?: string }> = [];
    for (const line of r.stdout.split(/\r?\n/).slice(1)) {
      const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m) out.push({ pid: Number(m[1]), name: m[2], cmd: (m[3] || "").slice(0, 200) });
    }
    return out;
  }

  async killProcess(pid: number): Promise<{ pid: number; killed: boolean; message: string }> {
    const r = await sshShell(this.target(), this.identityFile, `kill -TERM ${Number(pid)} 2>&1; sleep 1; kill -KILL ${Number(pid)} 2>/dev/null; echo done`, { timeoutMs: 15_000 });
    return { pid, killed: true, message: r.stdout.trim() || "已发送结束信号" };
  }
}

/** Agent-backed executor (wraps the existing RemoteClient). */
export class AgentExecutor implements Executor {
  readonly transport = "agent" as const;
  private client: RemoteClient;
  constructor(readonly machine: RemoteMachine, defaultTimeoutMs = 120_000) {
    this.client = new RemoteClient(machine, defaultTimeoutMs);
  }
  health(timeoutMs = 5_000): Promise<HealthInfo> { return this.client.health(timeoutMs); }
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> { return this.client.exec(command, options); }
  fs(op: string, payload: Record<string, unknown>): Promise<unknown> { return this.client.fs(op, payload); }
  async upload(localPath: string, remotePath: string) { return this.client.upload(localPath, remotePath); }
  async download(remotePath: string, localPath: string) { return this.client.download(remotePath, localPath); }
  sysinfo(): Promise<SysInfo> { return this.client.sysinfo(); }
  processes() { return this.client.processes(); }
  killProcess(pid: number) { return this.client.killProcess(pid); }
  startJob(command: string, options: ExecOptions = {}) { return this.client.startJob(command, options); }
  listJobs() { return this.client.listJobs(); }
  jobOutput(id: string) { return this.client.jobOutput(id); }
  killJob(id: string) { return this.client.killJob(id); }
}
