/**
 * @dsh-external/dsh-remote-control — DeepSeek Harness 远程控制插件（控制器侧）。
 *
 * 核心能力：
 *   remote_connect         — 一键接入：IP + 用户名 + 密码 → 自动部署/启动代理并登记
 *   remote_connect_reverse — 反向接入：直连不通、目标机能连回本机时自动建认证隧道
 *   remote_deploy_command  — 幂等再生成某台机器的部署命令（token 复用，不失效）
 *   remote_diagnose        — 三阶段连通性诊断（端口指纹 + HTTP 探测 + 目标侧排查命令）
 *   remote_workspace       — 浏览/创建/选定远程文件夹作为工作区
 *   remote_machine_*       — 机器登记表管理（支持 direct/reverse 多路径自动切换）
 *   remote_tunnel          — 公网隧道（Cloudflare/ngrok/frp）地址的 set/show/clear
 *   remote_exec/fs/upload/download/sysinfo/processes — 远程操作
 *   remote_exec_bg/remote_job — 后台长任务（构建/测试/长脚本，不受单次请求超时限制）
 *
 * 目标机代理：包内 agent/dsh-remote-agent.mjs（零依赖单文件，Node 18+，支持
 * --reverse 反向隧道与 --token-sha256）。
 *
 * 规范：工具注册与网关监听均挂 ctx.effect（热重载/卸载自动清理）。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Context } from "cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "schemastery";
import { RemoteClient, type ExecResult, type HealthInfo, type JobInfo, type JobOutput, type SysInfo } from "./agent-http.js";
import {
  loadRegistry,
  normalizeTunnelUrl,
  resolveRegistryPath,
  saveRegistry,
  type MachineRegistry,
  type RemoteMachine,
} from "./registry.js";
import { ReverseGateway } from "./reverse.js";
import { HostCatalog } from "./catalog.js";
import { executionDefaults, isRemoteAbsolute, validateDefaultEnv } from "./execution.js";

export const name = "dsh-remote-control";
export const inject = ["tools", "webServer"];

export const Config = z.object({
  /** 机器登记表路径；默认 DSH_HOME/dsh-remote-control/machines.json */
  registryFile: z.string().default(""),
  /** 远程调用默认超时（毫秒）。 */
  defaultTimeoutMs: z.number().default(120_000),
  /** remote_machine_list 在线探测默认超时（毫秒）。 */
  healthProbeTimeoutMs: z.number().default(3_000),
  /** 反向隧道网关监听地址（目标机能访问到的本机地址）。 */
  reverseListenHost: z.string().default("0.0.0.0"),
  /** 反向隧道网关监听端口（目标机回连这里）。 */
  reverseListenPort: z.number().default(59_000),
  /** 本地代理端口段起始。 */
  reverseProxyStart: z.number().default(59_100),
  /** 本地代理端口段长度。 */
  reverseProxyCount: z.number().default(100),
});

export interface Config {
  registryFile: string;
  defaultTimeoutMs: number;
  healthProbeTimeoutMs: number;
  reverseListenHost: string;
  reverseListenPort: number;
  reverseProxyStart: number;
  reverseProxyCount: number;
}

const textOut = () => ({
  schema: { type: "string" as const },
  render: (_args: unknown, value: unknown) =>
    [{ type: "text" as const, text: String(value) }] as { type: "text"; text: string }[],
});

// ── 本地工具（bootstrap / 诊断用）────────────────────────────────────────────
interface LocalRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function decodeWindowsOutput(buf: Buffer): string {
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

function runLocal(file: string, args: string[], timeoutMs = 60_000): Promise<LocalRunResult> {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "buffer",
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
      const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ""));
      resolve({
        code,
        stdout: decodeWindowsOutput(outBuf),
        stderr: decodeWindowsOutput(errBuf),
      });
    });
  });
}

/** TCP 端口指纹：open / closed / timeout / closed(<errno>)。 */
function probeTcp(host: string, port: number, timeoutMs = 2_500): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const finish = (result: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const code = error?.code ?? "error";
      if (code === "ETIMEDOUT") finish("timeout");
      else if (code === "ECONNREFUSED") finish("closed");
      else finish(`closed(${code})`);
    });
  });
}

/** 应用层探测：/health 无需 token，401 即说明 agent 正常但需认证。 */
async function probeAgentHttp(host: string, port: number, timeoutMs = 2_500): Promise<string> {
  return probeAgentUrl(`http://${host}:${port}/health`, timeoutMs);
}

/** 公网隧道探测：直接对一个 base URL（可以是 https）取 /health。 */
async function probeAgentHttpUrl(baseUrl: string, timeoutMs = 5_000): Promise<string> {
  const url = baseUrl.endsWith("/") ? `${baseUrl}health` : `${baseUrl}/health`;
  return probeAgentUrl(url, timeoutMs);
}

async function probeAgentUrl(url: string, timeoutMs = 2_500): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 200) return "agent-ok(200)";
    if (res.status === 401) return "agent-ok(401=认证正常)";
    return `http-${res.status}(非 agent 响应)`;
  } catch (error) {
    if (controller.signal.aborted) return "timeout";
    return `http-fail(${error instanceof Error ? error.message : String(error)})`;
  } finally {
    clearTimeout(timer);
  }
}

/** 推测目标机能访问到的本机 IPv4 地址（取第一个非内网地址，否则第一个内网地址）。 */
function detectControllerHost(): string {
  const all: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) all.push(item.address);
    }
  }
  const publicIp = all.find((ip) => !/^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip));
  return publicIp ?? all[0] ?? "";
}

function agentScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "dsh-remote-agent.mjs");
}

/** 本包内置 agent 的版本号（读源码里的 VERSION 常量），用于和目标机在线版本对账。 */
function bundledAgentVersion(): string {
  try {
    const match = /const VERSION = "([^"]+)"/.exec(readFileSync(agentScriptPath(), "utf8"));
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function newToken(): string {
  return `dsh-rc-${randomBytes(16).toString("hex")}`;
}

/** agent 脚本 gzip(level 9) + base64（Linux/Windows 部署命令共用）。 */
function agentGzipBase64(): string {
  return gzipSync(Buffer.from(readFileSync(agentScriptPath(), "utf8"), "utf8"), { level: 9 }).toString("base64");
}

function validateDeployIdentity(id: string, token: string, extraArgs: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || !/^[A-Za-z0-9._-]+$/.test(token) ||
      extraArgs && !/^--reverse [A-Za-z0-9._-]+:[0-9]{1,5}$/.test(extraArgs)) {
    throw new Error("部署参数含 shell 特殊字符；为避免脚本注入，请手动启动 agent，或使用普通主机名和安全随机 token。");
  }
}
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** gzip(level 9) + base64 按 76 列折行的 Linux 部署命令（≈11KB，粘贴稳定）。 */
function buildLinuxDeployCommand(
  id: string,
  _host: string,
  port: number,
  token: string,
  extraArgs = "",
  workspace = "$HOME/dsh-workspace",
): string {
  validateDeployIdentity(id, token, extraArgs);
  const b64 = agentGzipBase64();
  const wrapped = b64.match(/.{1,76}/g)!.join("\n");
  const workspaceArg = workspace === "$HOME/dsh-workspace" ? '"$HOME/dsh-workspace"' : shellQuote(workspace);
  const args = `--host 0.0.0.0 --port ${port} --token ${token} --name "${id}" --workspace ${workspaceArg}${extraArgs ? ` ${extraArgs}` : ""}`;
  return [
    `mkdir -p ~/.dsh-remote-agent && base64 -d <<'DSH_EOF' | gunzip > ~/.dsh-remote-agent/dsh-remote-agent.mjs`,
    wrapped,
    "DSH_EOF",
    `chmod +x ~/.dsh-remote-agent/dsh-remote-agent.mjs`,
    `nohup node ~/.dsh-remote-agent/dsh-remote-agent.mjs ${args} > ~/.dsh-remote-agent/agent.log 2>&1 &`,
    `printf '%s\\n' ${shellQuote("agent 启动命令已提交，请检查 ~/.dsh-remote-agent/agent.log")}`,
  ].join("\n");
}

/**
 * Windows 无密码/直连失败场景：在目标机“本机控制台”粘贴执行的 PowerShell
 * 部署命令（空密码账户允许控制台登录，绕开 Windows 默认禁止空密码网络登录）。
 */
function buildWindowsBootstrapCommand(id: string, port: number, token: string, extraArgs = ""): string {
  validateDeployIdentity(id, token, extraArgs);
  const b64 = agentGzipBase64();
  const bat = `@echo off
setlocal EnableExtensions
set "DIR=%TEMP%\\dsh-remote-agent"
set "PORT=${port}"
set "TOKEN=${token}"
set "NODE_CMD="
where node >nul 2>nul && set "NODE_CMD=node"
if not defined NODE_CMD if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_CMD=%ProgramFiles%\\nodejs\\node.exe"
if not defined NODE_CMD if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_CMD=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
if not defined NODE_CMD if exist "D:\\deepseek harness\\tools\\node\\node.exe" set "NODE_CMD=D:\\deepseek harness\\tools\\node\\node.exe"
if not defined NODE_CMD if exist "C:\\deepseek harness\\tools\\node\\node.exe" set "NODE_CMD=C:\\deepseek harness\\tools\\node\\node.exe"
if not defined NODE_CMD if exist "%ProgramFiles%\\DeepSeek Harness\\tools\\node\\node.exe" set "NODE_CMD=%ProgramFiles%\\DeepSeek Harness\\tools\\node\\node.exe"
if not defined NODE_CMD (
  echo [ERROR] Node.js not found >>"%DIR%\\agent.log" 2>&1
  exit /b 1
)
netsh advfirewall firewall delete rule name="DSH Remote Agent" >nul 2>&1
netsh advfirewall firewall add rule name="DSH Remote Agent" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
"%NODE_CMD%" "%DIR%\\dsh-remote-agent.mjs" --host 0.0.0.0 --port %PORT% --token %TOKEN% --name "${id}" --workspace "%USERPROFILE%\\dsh-workspace"${extraArgs ? ` ${extraArgs}` : ""} >>"%DIR%\\agent.log" 2>&1
`;
  return [
    `$d="$env:TEMP\\dsh-remote-agent"; New-Item -ItemType Directory -Path $d -Force | Out-Null`,
    `$z="$d\\agent.gz"; [IO.File]::WriteAllBytes($z,[Convert]::FromBase64String('${b64}'))`,
    `$inputStream=[IO.File]::OpenRead($z);$gzip=[IO.Compression.GZipStream]::new($inputStream,[IO.Compression.CompressionMode]::Decompress);$outputStream=[IO.File]::Create("$d\\dsh-remote-agent.mjs");try{$gzip.CopyTo($outputStream)}finally{$outputStream.Dispose();$gzip.Dispose();$inputStream.Dispose()};Remove-Item $z -Force`,
    `$bat = @'`,
    bat,
    `'@`,
    `Set-Content -Path "$d\\start-agent.bat" -Value $bat -Encoding ASCII`,
    `schtasks /Create /F /TN "DSH Remote Agent" /TR "$d\\start-agent.bat" /SC ONLOGON /RL HIGHEST | Out-Null`,
    `schtasks /Run /TN "DSH Remote Agent" | Out-Null`,
    `"agent 已启动（端口 ${port}，日志: $d\\agent.log）"`,
  ].join("\n");
}

/** 目标机能访问本机时的短命令：先经反向网关 DSH-FETCH 拉取 agent，再启动。 */
function buildLinuxShortCommand(id: string, port: number, token: string, controllerHost: string, gatewayPort: number, extraArgs = ""): string {
  validateDeployIdentity(id, token, extraArgs);
  if (!/^[A-Za-z0-9._-]+$/.test(controllerHost)) throw new Error("controller_host 必须是普通 IP 或主机名。");
  const args = `--host 0.0.0.0 --port ${port} --token ${token} --name "${id}" --workspace "$HOME/dsh-workspace"${extraArgs ? ` ${extraArgs}` : ""}`;
  return [
    `bash -c '`,
    `exec 3<>/dev/tcp/${controllerHost}/${gatewayPort} || exit 1`,
    `printf "DSH-FETCH ${token}\\n" >&3`,
    `mkdir -p ~/.dsh-remote-agent && cat <&3 > ~/.dsh-remote-agent/dsh-remote-agent.mjs`,
    `exec 3<&-`,
    `chmod +x ~/.dsh-remote-agent/dsh-remote-agent.mjs`,
    `nohup node ~/.dsh-remote-agent/dsh-remote-agent.mjs ${args} > ~/.dsh-remote-agent/agent.log 2>&1 &`,
    `'`,
  ].join("\n");
}

/** Windows 短命令：PowerShell + TcpClient 拉取 agent，再写本地计划任务启动。 */
function buildWindowsShortCommand(id: string, port: number, token: string, controllerHost: string, gatewayPort: number, extraArgs = ""): string {
  validateDeployIdentity(id, token, extraArgs);
  if (!/^[A-Za-z0-9._-]+$/.test(controllerHost)) throw new Error("controller_host 必须是普通 IP 或主机名。");
  const bat = [
    `@echo off`,
    `set "NODE_CMD="`,
    `where node >nul 2>nul && set "NODE_CMD=node"`,
    `if not defined NODE_CMD if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_CMD=%ProgramFiles%\\nodejs\\node.exe"`,
    `if not defined NODE_CMD (echo Node.js not found & exit /b 1)`,
    `netsh advfirewall firewall add rule name="DSH Remote Agent" dir=in action=allow protocol=TCP localport=${port} >nul 2>&1`,
    `"%NODE_CMD%" "%TEMP%\\dsh-remote-agent\\dsh-remote-agent.mjs" --host 0.0.0.0 --port ${port} --token ${token} --name "${id}" --workspace "%USERPROFILE%\\dsh-workspace"${extraArgs ? ` ${extraArgs}` : ""} >>"%TEMP%\\dsh-remote-agent\\agent.log" 2>&1`,
  ].join("\r\n");
  return [
    `$h='${controllerHost}';$p=${gatewayPort};$t='${token}'`,
    `$d="$env:TEMP\\dsh-remote-agent"; New-Item -ItemType Directory -Path $d -Force | Out-Null`,
    `$c=[Net.Sockets.TcpClient]::new($h,$p);$s=$c.GetStream();$w=[Text.Encoding]::UTF8.GetBytes("DSH-FETCH $t\`n");$s.Write($w,0,$w.Length)`,
    `$o=[IO.File]::Create("$d\\dsh-remote-agent.mjs");$s.CopyTo($o);$o.Close();$c.Close()`,
    `$bat = @'`,
    bat,
    `'@`,
    `Set-Content -Path "$d\\start-agent.bat" -Value $bat -Encoding ASCII`,
    `schtasks /Create /F /TN "DSH Remote Agent" /TR "$d\\start-agent.bat" /SC ONLOGON /RL HIGHEST | Out-Null`,
    `schtasks /Run /TN "DSH Remote Agent" | Out-Null`,
    `"agent 已启动（端口 ${port}）"`,
  ].join("\n");
}

/** 远程路径是否绝对（盘符 / 反斜杠 / 正斜杠 / UNC）。 */
function isAbsoluteRemotePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) || p.startsWith("/");
}

function joinRemote(machine: RemoteMachine, base: string, sub: string): string {
  const joiner = machine.platform === "win32" ? path.win32 : path.posix;
  return joiner.join(base, sub);
}

function resolveRemotePath(machine: RemoteMachine, p: string, what: string): string {
  if (!p) throw new Error(`缺少${what}路径`);
  if (isAbsoluteRemotePath(p)) return p;
  if (!machine.workspace) {
    throw new Error(
      `${what}使用了相对路径 "${p}"，但机器 "${machine.id}" 还没设置工作区。` +
      `请先用 remote_workspace(operation=list) 浏览并 remote_workspace(operation=set, path=…) 选定，` +
      `或改用绝对路径。`,
    );
  }
  return joinRemote(machine, machine.workspace, p);
}

// ── Windows 一键接入（SMB 管理共享 + schtasks，零第三方依赖）──────────────────
interface BootstrapInput {
  token: string;
  id: string;
  host: string;
  username: string;
  password: string;
  port: number;
  /** 默认工作区；缺省 %USERPROFILE%\dsh-workspace。 */
  workspace?: string;
}

const WINDOWS_START_BAT = `@echo off
rem Auto-generated by dsh-remote-control. Remote dir: C:\\Windows\\Temp\\dsh-remote-agent
setlocal EnableExtensions
set "DIR=C:\\Windows\\Temp\\dsh-remote-agent"
set "PORT=__PORT__"
set "TOKEN=__TOKEN__"
set "WORKSPACE=__WORKSPACE__"
set "NODE_CMD="
where node >nul 2>nul && set "NODE_CMD=node"
if not defined NODE_CMD if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_CMD=%ProgramFiles%\\nodejs\\node.exe"
if not defined NODE_CMD if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_CMD=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
if not defined NODE_CMD if exist "D:\\deepseek harness\\tools\\node\\node.exe" set "NODE_CMD=D:\\deepseek harness\\tools\\node\\node.exe"
if not defined NODE_CMD if exist "C:\\deepseek harness\\tools\\node\\node.exe" set "NODE_CMD=C:\\deepseek harness\\tools\\node\\node.exe"
if not defined NODE_CMD if exist "%ProgramFiles%\\DeepSeek Harness\\tools\\node\\node.exe" set "NODE_CMD=%ProgramFiles%\\DeepSeek Harness\\tools\\node\\node.exe"
if not defined NODE_CMD (
  echo [ERROR] Node.js not found on %COMPUTERNAME% >>"%DIR%\\agent.log" 2>&1
  exit /b 1
)
netsh advfirewall firewall delete rule name="DSH Remote Agent" >nul 2>&1
netsh advfirewall firewall add rule name="DSH Remote Agent" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
"%NODE_CMD%" "%DIR%\\dsh-remote-agent.mjs" --host 0.0.0.0 --port %PORT% --token %TOKEN% --name "%COMPUTERNAME%" --workspace "%WORKSPACE%" >>"%DIR%\\agent.log" 2>&1
`;

async function bootstrapWindowsAgent(input: BootstrapInput): Promise<{ machine: RemoteMachine; log: string; health: HealthInfo; verify: string }> {
  const { id, host, username, password, port } = input;
  if (input.workspace && (!isRemoteAbsolute(input.workspace) || /["%\r\n!]/.test(input.workspace))) {
    throw new Error("Windows 自动部署工作区须为绝对路径，且不能包含引号、换行或环境变量展开符。");
  }
  const share = `\\\\${host}\\admin$`;
  const remoteDir = path.win32.join(share, "Temp", "dsh-remote-agent");
  const token = input.token;
  if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error("Windows 自动部署需要不含 shell 特殊字符的 token；请改用手动 agent 启动方式。");
  let mounted = false;

  try {
    const mount = await runLocal("net.exe", ["use", share, `/user:${username}`, password], 30_000);
    if (mount.code !== 0) {
      const detail = `${mount.stdout}\n${mount.stderr}`.trim() || "(无输出)";
      if (/1326|username|password|登录失败/i.test(detail)) {
        const emptyHint = !password
          ? " 注意：Windows 默认禁止空密码账号网络登录（LimitBlankPasswordUse）。请给目标机设置密码后重试；或在该机上禁用该限制（secpol.msc → 本地策略 → 安全选项 → “账户: 使用空密码的本地账户只允许进行控制台登录”设为禁用）。"
          : "";
        throw new Error(`目标机 ${host} 拒绝了用户名/密码（net use exit ${mount.code}，错误 1326）。请确认账号是该机的管理员账号。${emptyHint}`);
      }
      if (/53|67|找不到网络路径|network path/i.test(detail)) {
        throw new Error(
          `无法访问 ${host} 的管理共享 admin$（net use exit ${mount.code}：${detail.slice(0, 300)}）。` +
          `目标机需开启“文件和打印机共享”（SMB 445），且账号属于 Administrators 组。`,
        );
      }
      throw new Error(`net use 失败（exit ${mount.code}）：${detail.slice(0, 600)}`);
    }
    mounted = true;

    mkdirSync(remoteDir, { recursive: true });
    writeFileSync(path.win32.join(remoteDir, "dsh-remote-agent.mjs"), readFileSync(agentScriptPath(), "utf8"), "utf8");
    const bat = WINDOWS_START_BAT
      .replaceAll("__PORT__", String(port))
      .replaceAll("__TOKEN__", token)
      .replaceAll("__WORKSPACE__", input.workspace || "%USERPROFILE%\\dsh-workspace");
    writeFileSync(path.win32.join(remoteDir, "start-agent.bat"), bat, "utf8");

    const tr = `C:\\Windows\\Temp\\dsh-remote-agent\\start-agent.bat`;
    const createBase = ["/create", "/s", host, "/u", username, "/p", password, "/tn", "DSH Remote Agent", "/tr", tr, "/sc", "onlogon", "/f"];
    let created = await runLocal("schtasks.exe", [...createBase, "/ru", username, "/rp", password, "/rl", "highest"], 45_000);
    if (created.code !== 0) {
      created = await runLocal("schtasks.exe", createBase, 45_000);
    }
    if (created.code !== 0) {
      throw new Error(`远程创建计划任务失败（schtasks exit ${created.code}）：${(created.stdout + "\n" + created.stderr).trim().slice(0, 600) || "(无输出)"}`);
    }
    const run = await runLocal("schtasks.exe", ["/run", "/s", host, "/u", username, "/p", password, "/tn", "DSH Remote Agent"], 45_000);
    if (run.code !== 0) {
      throw new Error(`远程启动计划任务失败（schtasks exit ${run.code}）：${(run.stdout + "\n" + run.stderr).trim().slice(0, 600) || "(无输出)"}`);
    }

    const machine: RemoteMachine = { id, name: id, host, port, token, enabled: true, platform: "win32", tokenCreatedAt: Date.now() };
    const client = new RemoteClient(machine, 15_000);
    let lastError = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const health = await client.health(3_000);
        machine.platform = health.platform;
        // 一步连接：agent 启动时已按 --workspace 建好默认工作区，直接落到登记表。
        machine.workspace = health.workspace || input.workspace;
        let verify = "";
        try {
          const probe = await client.exec("echo dsh-remote-control-ok", { timeoutMs: 10_000 });
          verify = probe.exitCode === 0 ? probe.stdout.trim() || `(空输出, 退出码 ${probe.exitCode})` : `(退出码 ${probe.exitCode})`;
        } catch (error) {
          verify = `(验证失败: ${error instanceof Error ? error.message : String(error)})`;
        }
        return {
          machine,
          health,
          verify,
          log: `在线 v${health.version}（hostname=${health.hostname}）`,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === 5) {
          try {
            const log = readFileSync(path.win32.join(share, "Temp", "dsh-remote-agent", "agent.log"), "utf8").trim();
            if (log) lastError += `\n远程 agent 日志：\n${log.slice(-1200)}`;
          } catch {
            // 日志还不存在：继续等待。
          }
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    throw new Error(
      `agent 已部署并触发启动，但 90 秒内未能连接 ${host}:${port}。${lastError}\n` +
      `可稍后调用 remote_machine_list 再探测；若目标机没有 Node.js，请先安装 Node 18+ 或 DeepSeek Harness。`,
    );
  } finally {
    if (mounted) {
      await runLocal("net.exe", ["use", share, "/delete", "/y"], 15_000);
    }
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────
/**
 * Boot-safe 入口：任何异常都只降级（打印日志），绝不向 loader 抛出，
 * 保证插件自身问题永远不会阻断 harness 启动。
 */
export function apply(ctx: Context, rawConfig: Config): void {
  try {
    applyInternal(ctx, (rawConfig ?? {}) as Config);
  } catch (error) {
    const message = `[dsh-remote-control] 插件初始化失败（已降级跳过，不影响 harness 启动）: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    try {
      (ctx as Context & { logger?: { error?: (m: string) => void } }).logger?.error?.(message);
    } catch {
      // 日志不可用。
    }
  }
}

function applyInternal(ctx: Context, config: Config): void {
  const registryPath = resolveRegistryPath(config.registryFile);
  // 兜底默认值：测试环境/未走 schema 默认值加载时也不至于拿 undefined。
  const cfg = {
    defaultTimeoutMs: config.defaultTimeoutMs ?? 120_000,
    healthProbeTimeoutMs: config.healthProbeTimeoutMs ?? 3_000,
    reverseListenHost: config.reverseListenHost ?? "0.0.0.0",
    reverseListenPort: config.reverseListenPort ?? 59_000,
    reverseProxyStart: config.reverseProxyStart ?? 59_100,
    reverseProxyCount: config.reverseProxyCount ?? 100,
  };
  const logInfo = (message: string) => {
    try {
      (ctx as Context & { logger?: { info?: (m: string) => void } }).logger?.info?.(`[dsh-remote-control] ${message}`);
    } catch {
      // 日志不可用时静默。
    }
  };

  /** 单个工具注册失败只降级该工具，不影响其它工具与启动。 */
  const registerTool = (definition: any): any => {
    try {
      return ctx["tools"].register(definition);
    } catch (error) {
      const toolName = (definition as { name?: string })?.name ?? "?";
      logInfo(`工具 ${toolName} 注册失败（已跳过，不影响启动）: ${error instanceof Error ? error.message : String(error)}`);
      return () => {};
    }
  };

  const readRegistry = (): MachineRegistry => loadRegistry(registryPath);
  const save = (registry: MachineRegistry) => saveRegistry(registryPath, registry);
  const findMachine = (id: string): RemoteMachine | null => {
    return readRegistry().machines.find((m) => m.id === id) ?? null;
  };
  /**
   * Resolve the target machine for a tool call. An explicit id wins; otherwise the
   * machine the UI marks as current. This is a convenience default for the same
   * per-call targeting — it is not a sandbox or a session binding.
   */
  const resolveTarget = (requested?: string): { id: string; machine: RemoteMachine } => {
    const id = requested?.trim();
    if (id) {
      const machine = findMachine(id);
      if (!machine) throw new Error(`机器 "${id}" 未登记。先用 remote_machine_list 查看，或 remote_connect 一键接入。`);
      return { id, machine };
    }
    const registry = readRegistry();
    const active = registry.activeMachineId ? registry.machines.find((m) => m.id === registry.activeMachineId) : undefined;
    if (!active) {
      throw new Error("未指定机器，且当前目标是本机。请传入 machine=<机器id>，或在输入框上方的目标指示器里选择远程电脑。");
    }
    return { id: active.id, machine: active };
  };
  const markActive = (id: string): void => {
    const registry = readRegistry();
    if (!registry.machines.some((m) => m.id === id) || registry.activeMachineId === id) return;
    registry.activeMachineId = id;
    save(registry);
  };
  const clientFor = (id?: string): RemoteClient => {
    const { machine } = resolveTarget(id);
    markActive(machine.id);
    return new RemoteClient(machine, config.defaultTimeoutMs);
  };
  const updateMachine = (id: string, mutate: (m: RemoteMachine) => void): RemoteMachine => {
    const registry = readRegistry();
    const machine = registry.machines.find((m) => m.id === id);
    if (!machine) throw new Error(`机器 "${id}" 未登记。`);
    mutate(machine);
    save(registry);
    return machine;
  };

  const catalog = new HostCatalog((original, health) => {
    const current = findMachine(original.id);
    if (!current || current.token !== original.token || current.host !== original.host || current.tunnelUrl !== original.tunnelUrl) return;
    updateMachine(original.id, (m) => {
      m.lastSeenAt = Date.now();
      m.lastAgentVersion = health.version;
      m.lastHostname = health.hostname;
      m.platform = health.platform;
      if (!m.workspace && health.workspace && isRemoteAbsolute(health.workspace)) m.workspace = health.workspace;
    });
  });
  const removeMachine = async (id: string, force = false): Promise<string> => {
    const machine = findMachine(id);
    if (!machine) return `机器 "${id}" 不存在，未做改动。`;
    const status = machine.enabled ? await catalog.probe(machine, cfg.healthProbeTimeoutMs, true) : undefined;
    if (!force && (status?.online || gateway.status().some((item) => item.machineId === id && item.connected))) {
      return `机器 "${id}" 当前在线${status?.health?.runningJobs ? "且有后台任务" : ""}，未移除。确需移除请指定 force=true；移除登记不会终止目标机任务。`;
    }
    const registry = readRegistry();
    registry.machines = registry.machines.filter((m) => m.id !== id);
    if (registry.activeMachineId === id) registry.activeMachineId = undefined;
    save(registry);
    catalog.forget(id);
    return `已移除机器 "${id}"。`;
  };

  // Auto-connect only observes explicitly opted-in hosts; it never installs or runs commands.
  ctx.effect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      const run = async () => {
        const machines = readRegistry().machines.filter((m) => m.enabled && m.autoConnect);
        for (let i = 0; i < machines.length && !disposed; i += 4) {
          await Promise.all(machines.slice(i, i + 4).map((m) => catalog.probe(m, cfg.healthProbeTimeoutMs)));
        }
      };
      void run().catch((error) => logInfo(`自动探活失败：${String(error)}`));
    }, 1000);
    timer.unref();
    return () => { disposed = true; clearTimeout(timer); };
  }, "dsh-remote-control: opted-in host discovery");

  /** 每个目标机组合对应一个本机工作区目录（默认在登记表同级的 workspaces/<id>）。 */
  const ensureLocalWorkspace = (machine: RemoteMachine): string => {
    if (!machine.localWorkspace) {
      machine.localWorkspace = path.join(path.dirname(registryPath), "workspaces", machine.id.replace(/[^A-Za-z0-9._-]/g, "-"));
    }
    try {
      mkdirSync(machine.localWorkspace, { recursive: true });
    } catch {
      // 目录创建失败不阻断连接，仅保留路径。
    }
    return machine.localWorkspace;
  };

  /** 面板用：剔除密码/token 明文。 */
  const sanitizeMachine = (m: RemoteMachine) => ({
    id: m.id,
    name: m.name,
    host: m.host,
    port: m.port,
    platform: m.platform,
    osHint: m.osHint,
    workspace: m.workspace,
    localWorkspace: m.localWorkspace,
    enabled: m.enabled,
    hasPassword: Boolean(m.password),
    paths: m.paths,
    tunnelUrl: m.tunnelUrl,
    autoConnect: Boolean(m.autoConnect),
    defaultCwd: m.defaultCwd,
    defaultEnvKeys: Object.keys(m.defaultEnv ?? {}),
    lastSeenAt: m.lastSeenAt,
    lastAgentVersion: m.lastAgentVersion,
    lastHostname: m.lastHostname,
  });

  /** 读取 HTTP 请求体（小上限，面板接口足够）。 */
  const readHttpBody = (req: import("node:http").IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error("请求体过大"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  // ── 反向隧道网关（随插件生命周期启停；目标机回连时自动配对）──────────────────
  const gateway = new ReverseGateway({
    listenHost: cfg.reverseListenHost,
    listenPort: cfg.reverseListenPort,
    proxyStart: cfg.reverseProxyStart,
    proxyCount: cfg.reverseProxyCount,
    agentFilePath: agentScriptPath(),
    findMachineByToken: (token) => {
      return readRegistry().machines.find((m) =>
        m.enabled && (m.token === token || (m.tokenSha256 && m.tokenSha256 === token.toLowerCase())),
      );
    },
    onPathsUpdate: (machineId, paths, reversePort) => {
      try {
        updateMachine(machineId, (m) => {
          m.paths = paths;
          m.reversePort = reversePort;
        });
      } catch (error) {
        logInfo(`更新反向路径失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    log: logInfo,
  });
  ctx.effect(() => {
    void gateway.start().catch((error) => logInfo(`反向网关启动失败（端口 ${config.reverseListenPort} 可能被占用）: ${String(error)}`));
    return () => {
      void gateway.stop().catch(() => {});
    };
  }, "@dsh-external/dsh-remote-control: reverse gateway");

  // client-modules 负缓存自愈（与 super-injector 同法）：包在客户端首次扫描
  // 时若尚未声明 dsh.client，pkgMeta 会永久缓存 null，设置页面板不会注册。
  // 本插件每次加载都清掉自己的缓存并重解析，保证面板在重启/热载后都能出现。
  ctx.effect(() => {
    try {
      const clientModules = (ctx as Context & { get?: (name: string) => unknown }).get?.("clientModules") as
        | { pkgMeta?: Map<string, unknown>; processOne?: (name: string) => unknown }
        | undefined;
      if (clientModules?.pkgMeta?.delete) clientModules.pkgMeta.delete("@dsh-external/dsh-remote-control");
      if (typeof clientModules?.processOne === "function") {
        clientModules.processOne("@dsh-external/dsh-remote-control");
        logInfo("client-modules pkgMeta 缓存已清并重解析（设置页远程控制面板注册）");
      }
    } catch {
      // 缓存自愈失败不阻塞启动。
    }
    return () => {};
  }, "@dsh-external/dsh-remote-control: client-meta-heal");

  // ── 反向接入共享流程 ─────────────────────────────────────────────────────
  const reverseFlow = async (id: string, host: string, agentPort: number, controllerHost: string, displayName: string, workspace?: string): Promise<string> => {
    const existing = findMachine(id);
    const token = existing?.token || newToken();
    const tokenNote = existing?.token ? "（复用已登记 token）" : "";
    const machine: RemoteMachine = {
      ...existing,
      id,
      name: displayName || id,
      host,
      port: agentPort,
      token,
      enabled: true,
      tokenCreatedAt: existing?.tokenCreatedAt ?? Date.now(),
      workspace: workspace || existing?.workspace,
    };

    let listenPort: number;
    try {
      listenPort = await gateway.start();
    } catch (error) {
      return `错误：本机反向网关启动失败（端口 ${cfg.reverseListenPort}）：${error instanceof Error ? error.message : String(error)}`;
    }

    const registry = readRegistry();
    ensureLocalWorkspace(machine);
    registry.machines = [...registry.machines.filter((m) => m.id !== id), machine];
    save(registry);

    try {
      await gateway.ensureProxy(machine, agentPort);
    } catch (error) {
      return `错误：本地代理端口分配失败：${error instanceof Error ? error.message : String(error)}`;
    }

    const extra = `--reverse ${controllerHost}:${listenPort}`;
    const workspaceArg = machine.workspace ?? "$HOME/dsh-workspace";
    const command = buildLinuxDeployCommand(id, host, agentPort, token, extra, workspaceArg);
    return [
      `反向接入已准备就绪 ${tokenNote}：`,
      `  目标机回连地址: ${controllerHost}:${listenPort}（本机网关已监听，带 token 认证）`,
      `  上线后机器自动使用 reverse 路径，并自动同步工作区 ${machine.workspace ?? workspaceArg}。`,
      `✅ 短命令（推荐粘贴；目标机需能访问 ${controllerHost}:${listenPort}，内容只有几百字符）：`,
      `Linux：`,
      "```bash",
      buildLinuxShortCommand(id, agentPort, token, controllerHost, listenPort, extra),
      "```",
      `Windows：`,
      "```powershell",
      buildWindowsShortCommand(id, agentPort, token, controllerHost, listenPort, extra),
      "```",
      `备选长命令（无需目标机访问本机，内置全部文件）：`,
      `Linux 目标机：把下面整段命令一次完整粘贴到目标机执行（需要 Node 18+）：`,
      "```bash",
      command,
      "```",
      `Windows 目标机（无密码也可以）：在目标机本机 PowerShell 里整段粘贴执行：`,
      "```powershell",
      buildWindowsBootstrapCommand(id, agentPort, token, extra),
      "```",
      `目标机执行后，remote_machine_list 会显示“反向隧道：在线”；若一直未上线，先用 remote_diagnose(host="${host}") 排查。`,
    ].join("\n");
  };

  // ── 一键接入（直连）───────────────────────────────────────────────────────
  const connectToolDef = defineTool({
    name: "remote_connect",
    description: "一步连接远程电脑：只填 IP/用户名/密码即可自动部署、上线、建默认工作区并验证（id 可选；直连失败可自动转反向隧道）。",
    parameters: {
      id: { type: "string", description: "机器唯一标识（可选；缺省按 IP 自动生成）。" },
      host: { type: "string", required: true, description: "目标机 IP 或主机名，如 192.168.1.20。" },
      username: { type: "string", required: true, description: "目标机管理员账号（如 Administrator 或 DOMAIN\\user）。" },
      password: { type: "string", description: "目标机密码；无密码的电脑可留空（注意：Windows 默认禁止空密码网络登录，见返回值提示）。" },
      os: { type: "string", enum: ["auto", "windows", "linux"], description: "目标系统；auto 先端口指纹再选择路径。" },
      agent_port: { type: "integer", description: "目标机代理端口（默认 5188）。" },
      workspace: { type: "string", description: "默认工作区绝对路径（缺省 Windows: %USERPROFILE%\\dsh-workspace；Linux: ~/dsh-workspace）。" },
      controller_host: { type: "string", description: "可选：目标机可见的本机 IP。直连失败时同一次调用自动转反向接入。" },
      name: { type: "string", description: "备注名（默认同 id）。" },
    },
    output: textOut(),
    async execute(args: {
      id?: string; host: string; username: string; password?: string;
      os?: "auto" | "windows" | "linux"; agent_port?: number; workspace?: string; controller_host?: string; name?: string;
    }) {
      const host = args.host.trim();
      if (!/^[A-Za-z0-9._-]{1,253}$/.test(host)) return `错误：host 应为 IP 或主机名（收到 "${host}"）。`;
      const id = (args.id?.trim() || `pc-${host.replace(/[^A-Za-z0-9._-]/g, "-")}`).slice(0, 64);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return `错误：id 只允许字母数字和 . _ -（收到 "${id}"）。`;
      const port = args.agent_port && args.agent_port > 0 && args.agent_port < 65536 ? Math.floor(args.agent_port) : 5188;
      const displayName = args.name?.trim() || id;
      const workspace = args.workspace?.trim() || undefined;

      // token 幂等：同一 id 复用登记表里的 token，旧部署命令不会失效。
      const existing = findMachine(id);
      const token = existing?.token || newToken();
      const tokenNote = existing?.token ? "（复用已登记 token，旧部署命令仍然有效）" : "";

      const saveMachine = (machine: RemoteMachine) => {
        ensureLocalWorkspace(machine);
        const registry = readRegistry();
        const previous = registry.machines.find((m) => m.id === id);
        registry.machines = [...registry.machines.filter((m) => m.id !== id), { ...previous, ...machine }];
        save(registry);
      };
      const baseMachine: RemoteMachine = {
        id, name: displayName, host, port, token, enabled: true,
        tokenCreatedAt: existing?.tokenCreatedAt ?? Date.now(),
        workspace: workspace ?? existing?.workspace,
        username: args.username,
        password: args.password ?? existing?.password ?? "",
        osHint: args.os ?? existing?.osHint ?? "auto",
        tunnelUrl: existing?.tunnelUrl,
      };

      const linuxFlow = async () => {
        const workspaceArg = workspace ?? existing?.workspace ?? "$HOME/dsh-workspace";
        const command = buildLinuxDeployCommand(id, host, port, token, "", workspaceArg);
        saveMachine({ ...baseMachine, platform: "linux", workspace: workspace ?? existing?.workspace });
        return [
          `已${existing ? "复用并" : ""}登记机器 "${id}"（${host}:${port}）${tokenNote}`,
          `目标机是 Linux：把下面整段命令一次完整粘贴到目标机执行（需要 Node 18+）：`,
          "```bash",
          command,
          "```",
          `粘贴后无需任何配置：agent 自动创建工作区 ${workspaceArg}，上线时 remote_machine_list 会自动同步。`,
          `直连不通时：remote_connect 加参数 controller_host=<目标机可见的本机IP> 可自动转反向接入。`,
        ].join("\n");
      };

      const windowsFlow = async () => {
        try {
          const { machine, log, verify } = await bootstrapWindowsAgent({ id, host, username: args.username, password: args.password ?? "", port, workspace, token });
          saveMachine({ ...machine, name: displayName, tokenCreatedAt: baseMachine.tokenCreatedAt });
          return [
            `✅ 一步连接完成：机器 "${id}"（${host}:${port}）${log}${tokenNote}`,
            `   工作区：${machine.workspace ?? "（未设置，用 remote_workspace 选择）"}`,
            `   验证命令：echo dsh-remote-control-ok → ${verify}`,
            `代理已随计划任务常驻（重启目标机自启）。现在可直接 remote_exec / remote_fs 操作，相对路径基于工作区。`,
          ].join("\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (args.controller_host?.trim()) {
            return [
              `Windows 自动部署失败：${message}`,
              `已按 controller_host 自动切换为反向接入：`,
              await reverseFlow(id, host, port, args.controller_host.trim(), displayName, workspace),
            ].join("\n");
          }
          return [
            `Windows 自动部署失败：${message}`,
            args.password
              ? `手动方案：把 agent 目录拷到目标机，运行 install-windows.bat --port ${port} --token ${token}，然后 remote_machine_add 登记。`
              : `该电脑未设置密码：Windows 默认禁止空密码账户“网络登录”，自动推送不可用。请在目标机本机（控制台）打开 PowerShell，整段粘贴执行下面命令完成部署（无需密码）：`,
            ...(args.password ? [] : ["```powershell", buildWindowsBootstrapCommand(id, port, token), "```"]),
            `提示：若目标机能连回本机，下次调用 remote_connect 时带上 controller_host=<目标机可见的本机IP>，可自动转反向接入。`,
          ].join("\n");
        }
      };

      if (args.os === "linux") return linuxFlow();
      if (args.os === "windows") return windowsFlow();

      // os=auto：端口指纹先判定路径，不再盲目 net use。
      const [tcp22, tcp445, tcpAgent] = await Promise.all([
        probeTcp(host, 22), probeTcp(host, 445), probeTcp(host, port),
      ]);
      if (tcp22 === "open") return linuxFlow();
      if (tcp445 === "open") {
        try {
          const { machine, log, verify } = await bootstrapWindowsAgent({ id, host, username: args.username, password: args.password ?? "", port, workspace, token });
          saveMachine({ ...machine, name: displayName, tokenCreatedAt: baseMachine.tokenCreatedAt });
          return [
            `✅ 一步连接完成：端口指纹 22=${tcp22}/445=${tcp445} → Windows，自动部署成功。${log}${tokenNote}`,
            `   工作区：${machine.workspace ?? "（未设置）"}`,
            `   验证命令：echo dsh-remote-control-ok → ${verify}`,
            `现在可直接 remote_exec / remote_fs 操作。`,
          ].join("\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (args.controller_host?.trim()) {
            return [
              `端口指纹判定 Windows（445 open）但直连部署失败：${message}`,
              `已自动切换为反向接入：`,
              await reverseFlow(id, host, port, args.controller_host.trim(), displayName, workspace),
            ].join("\n");
          }
          return [
            `端口指纹判定为 Windows（445 open），但自动部署失败：${message}`,
            `如目标机实为 Linux（Samba 的 445），请改 os=linux 重试。`,
            args.password
              ? `手动方案：拷贝 agent 目录运行 install-windows.bat --port ${port} --token ${token}。`
              : `该电脑未设置密码：Windows 默认禁止空密码账户“网络登录”。请在目标机本机 PowerShell 里整段粘贴执行下面命令（无需密码）：`,
            ...(args.password ? [] : ["```powershell", buildWindowsBootstrapCommand(id, port, token), "```"]),
          ].join("\n");
        }
      }

      // 都不可达：网络诊断 + Linux 命令兜底 + 反向隧道提示。
      const http = tcpAgent === "open" ? await probeAgentHttp(host, port) : "未探测（TCP 不通）";
      if (args.controller_host?.trim()) {
        return [
          `直连 ${host} 不可达（22=${tcp22}，445=${tcp445}，${port}=${tcpAgent}，/health=${http}）。`,
          `已自动切换为反向接入（同一次调用，无需再调 remote_connect_reverse）：`,
          await reverseFlow(id, host, port, args.controller_host.trim(), displayName, workspace),
        ].join("\n");
      }
      const workspaceArg = workspace ?? "$HOME/dsh-workspace";
      const command = buildLinuxDeployCommand(id, host, port, token, "", workspaceArg);
      saveMachine({ ...baseMachine, platform: tcp22 === "open" ? "linux" : undefined });
      return [
        `直连 ${host} 端口指纹：22=${tcp22}，445=${tcp445}，代理端口 ${port}=${tcpAgent}，HTTP=/health=${http}。`,
        `网络不可直连，无法自动部署。已预留机器登记 "${id}"（token 与本次一致，${tokenNote}）。`,
        `建议顺序：① 目标机能连回本机 → 重试 remote_connect 并带上 controller_host=<目标机可见的本机IP>（自动转反向隧道）；`,
        `② 先解决路由/防火墙后重试 remote_connect(os=auto)；③ Linux 目标机可先手动执行下面命令（一次完整粘贴，工作区自动创建为 ${workspaceArg}）：`,
        "```bash",
        command,
        "```",
        `注意：TCP 握手成功但 /health 无响应（如 ${tcpAgent}）说明中间设备拦截了应用层，不要当直连已通。`,
      ].join("\n");
    },
  });
  ctx.effect(() => registerTool(connectToolDef), "@dsh-external/dsh-remote-control: remote_connect");

  // ── 反向接入（也可由 remote_connect 自动调用）─────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_connect_reverse",
    description: "反向接入：直连不通但目标机能连回本机时，生成带 --reverse 的部署命令；目标机回连后自动建立认证隧道并切换机器路径。",
    parameters: {
      id: { type: "string", required: true, description: "机器 id（已登记则复用 token；未登记则创建）。" },
      host: { type: "string", required: true, description: "目标机 IP（仅用于登记直连信息）。" },
      agent_port: { type: "integer", description: "目标机代理端口（默认 5188）。" },
      controller_host: { type: "string", description: "目标机能访问到的本机 IP/域名；缺省自动探测本机 IPv4。" },
      workspace: { type: "string", description: "可选：默认工作区绝对路径（缺省 ~/dsh-workspace）。" },
      name: { type: "string", description: "备注名（默认同 id）。" },
    },
    output: textOut(),
    async execute(args: { id: string; host: string; agent_port?: number; controller_host?: string; workspace?: string; name?: string }) {
      const id = args.id.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return `错误：id 只允许字母数字和 . _ -。`;
      const host = args.host.trim();
      const agentPort = args.agent_port && args.agent_port > 0 && args.agent_port < 65536 ? Math.floor(args.agent_port) : 5188;
      const controllerHost = args.controller_host?.trim() || detectControllerHost();
      if (!controllerHost) return `错误：无法自动探测本机 IP，请提供 controller_host（目标机能访问到的本机 IP）。`;
      return reverseFlow(id, host, agentPort, controllerHost, args.name?.trim() || id, args.workspace?.trim() || undefined);
    },
  })), "@dsh-external/dsh-remote-control: remote_connect_reverse");

  // ── 部署命令再生成（幂等）────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_deploy_command",
    description: "为已登记机器幂等再生成部署命令（复用登记表 token，不会让旧命令失效；长结果被压缩时可随时重取）。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      os: { type: "string", enum: ["linux", "windows"], description: "目标系统（默认按登记平台，缺省 linux）。" },
      controller_host: { type: "string", description: "可选：附上反向隧道参数（目标机可见的本机 IP）。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; os?: "linux" | "windows"; controller_host?: string }) {
      const { machine } = resolveTarget(args.machine);
      if (!machine.token) return "该机器使用兼容哈希凭据，请在目标机保留 --token-sha256 配置并手动更新 agent；不会生成包含截断凭据的无效部署命令。";
      const token = machine.token;
      const osKind = args.os ?? (machine.platform === "win32" ? "windows" : "linux");
      const listenPort = gateway.isRunning() ? gateway.actualListenPort() : config.reverseListenPort;
      const controllerHost = args.controller_host?.trim() || (gateway.isRunning() ? detectControllerHost() : "");
      const extra = controllerHost ? `--reverse ${controllerHost}:${listenPort}` : "";

      if (osKind === "windows") {
        return [
          `机器 "${machine.id}" 的 Windows 部署命令（token 复用，可多次生成）。`,
          ...(controllerHost ? [
            `✅ 短命令（推荐粘贴；目标机需能访问 ${controllerHost}:${listenPort}）：`,
            "```powershell",
            buildWindowsShortCommand(machine.id, machine.port, token, controllerHost, listenPort, extra),
            "```",
            `备选长命令（无需目标机访问本机）：`,
          ] : [
            `无密码电脑也可用：在目标机本机 PowerShell 里整段粘贴执行（无需网络登录）：`,
          ]),
          "```powershell",
          buildWindowsBootstrapCommand(machine.id, machine.port, token, extra),
          "```",
          `备选（已设密码的电脑）：agent\\install-windows.bat --port ${machine.port} --token ${token}${extra ? ` ${extra}` : ""}`,
        ].join("\n");
      }
      const workspaceArg = machine.workspace ?? "$HOME/dsh-workspace";
      return [
        `机器 "${machine.id}" 的 Linux 部署命令（token 复用，可多次生成）。请一次完整粘贴，工作区 ${workspaceArg} 会自动创建：`,
        ...(controllerHost ? [
          `✅ 短命令（推荐粘贴；目标机需能访问 ${controllerHost}:${listenPort}）：`,
          "```bash",
          buildLinuxShortCommand(machine.id, machine.port, token, controllerHost, listenPort, extra),
          "```",
          `备选长命令（无需目标机访问本机）：`,
        ] : []),
        "```bash",
        buildLinuxDeployCommand(machine.id, machine.host, machine.port, token, extra, workspaceArg),
        "```",
      ].join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_deploy_command");

  // ── 连通性诊断 ───────────────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_diagnose",
    description: "三阶段连通性诊断：本机 TCP 端口指纹 + agent HTTP 探测 + 目标机侧排查命令，并给出下一步（直连/反向/防火墙）。host 传公网隧道 URL 时只做 HTTP 探测。",
    parameters: {
      host: { type: "string", required: true, description: "目标机 IP/主机名，或公网隧道地址（https://xxx.trycloudflare.com）。" },
      port: { type: "integer", description: "agent 端口（默认 5188）。" },
    },
    output: textOut(),
    async execute(args: { host: string; port?: number }) {
      const host = args.host.trim();
      const port = args.port && args.port > 0 && args.port < 65536 ? Math.floor(args.port) : 5188;

      // 公网隧道：TCP 指纹没有意义，直接看 HTTP 层。
      if (/^https?:\/\//i.test(host)) {
        const tunnelUrl = normalizeTunnelUrl(host);
        if (!tunnelUrl) return "错误：host 看起来是 URL，但不是合法的 http(s) 地址。";
        const probe = await probeAgentHttpUrl(tunnelUrl, 10_000);
        const ok = probe.startsWith("agent-ok");
        return [
          `【隧道探测】${tunnelUrl}`,
          `  /health = ${probe}`,
          ok
            ? "结论：隧道与 agent 都正常。用 remote_tunnel(machine=…, action=set, url=…) 挂到已登记机器上，或 remote_machine_add(..., tunnel_url=…)。"
            : probe.includes("http-fail")
              ? "结论：隧道地址不可达（域名解析/证书/cloudflared 未运行，或临时 URL 已失效）。在目标机确认 cloudflared 进程仍在运行，并重新获取 URL。"
              : `结论：隧道可达但返回 ${probe}。若为 502/503，通常是 cloudflared 已连上但本地 agent 未监听 5188。`,
          "提示：临时隧道地址每次重启都会变；长期使用建议固定域名隧道。",
        ].join("\n");
      }

      const [tcp22, tcp445, tcp5985, tcpAgent] = await Promise.all([
        probeTcp(host, 22), probeTcp(host, 445), probeTcp(host, 5985), probeTcp(host, port),
      ]);
      const http = tcpAgent === "open" ? await probeAgentHttp(host, port) : "未探测（TCP 不通）";

      const lines = [
        `【1. 本机侧探测】目标 ${host}：`,
        `  SSH 22        = ${tcp22}`,
        `  SMB 445       = ${tcp445}`,
        `  WinRM 5985    = ${tcp5985}`,
        `  agent ${port} = ${tcpAgent}（TCP）→ /health = ${http}`,
      ];
      if (http.startsWith("agent-ok")) {
        lines.push("结论：网络与 agent 都正常，可直接 remote_machine_add 登记使用。");
      } else if (tcpAgent === "open") {
        lines.push("结论：TCP 能握手但应用层无响应——大概率是中间设备（防火墙/NAT/安全软件）拦截，或端口被其它程序占用。");
      } else if (tcp22 === "open") {
        lines.push("结论：SSH 可达 → Linux 目标机。可用 remote_connect(os=linux) 或 remote_deploy_command 部署。");
      } else if (tcp445 === "open") {
        lines.push("结论：SMB 可达 → Windows 目标机。可用 remote_connect(os=windows) 自动部署。");
      } else if (tcp5985 === "open") {
        lines.push("结论：WinRM 可达但暂未实现其部署路径，建议在目标机手动跑 install-windows.bat。");
      } else {
        lines.push(`结论：${host} 的所有常用端口均不可达。若目标机 → 本机方向可达，用 remote_connect_reverse 建反向隧道。`);
      }
      lines.push(
        "",
        "【2. 目标机侧排查命令（在目标机上执行）】",
        `  ss -ltnp | grep -E ':(22|445|${port})\\b'   # 端口是否在监听`,
        `  curl -i 127.0.0.1:${port}/health            # 401 = agent 正常，只是未带 token`,
        "  sudo ufw status                          # Ubuntu 防火墙",
        "  sudo firewall-cmd --list-all              # RHEL/CentOS 防火墙",
        "",
        "【3. 方向性判断】",
        "  在目标机上执行: curl -m 3 http://<本机IP>:59000/ 不通也没关系——那是反向隧道端口，",
        "  能 TCP 连上即说明目标机 → 本机路径可用，直接 remote_connect_reverse。",
      );
      return lines.join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_diagnose");

  // ── 机器管理 ─────────────────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_machine_list",
    description: "列出已登记的远程机器（工作区/路径/反向隧道状态），并可选探测在线状态。",
    parameters: {
      probe: { type: "boolean", description: "是否联网探测每台机器的健康状态（默认 true）。" },
      timeout_ms: { type: "integer", description: "探测超时毫秒数（默认 3000；隧道链路建议调大）。" },
      refresh: { type: "boolean", description: "强制刷新，跳过 15 秒状态缓存；probe=false 时不联网。" },
    },
    output: textOut(),
    async execute(args: { probe?: boolean; timeout_ms?: number; refresh?: boolean }) {
      const probe = args.probe !== false;
      const timeoutMs = args.timeout_ms && args.timeout_ms > 0 ? args.timeout_ms : config.healthProbeTimeoutMs;
      const machines = readRegistry().machines;
      const reverseStatus = new Map(gateway.status().map((s) => [s.machineId, s]));
      if (machines.length === 0) {
        return `暂无远程机器。用 remote_connect(id, host, username, password) 一键接入，或 remote_connect_reverse 反向接入。\n登记表：${registryPath}`;
      }
      const lines: string[] = [`远程机器（登记表：${registryPath}）：`];
      const results = [];
      for (let i = 0; i < machines.length; i += 4) {
        results.push(...await Promise.all(machines.slice(i, i + 4).map(async (original) => {
          const observation = original.enabled && probe
            ? await catalog.probe(original, timeoutMs ?? cfg.healthProbeTimeoutMs, args.refresh === true)
            : catalog.peek(original);
          const m = findMachine(original.id) ?? original;
          const fresh = observation && Date.now() - observation.checkedAt < catalog.ttlMs;
          const ok = Boolean(fresh && observation.online);
          const busy = ok ? observation?.health?.runningJobs ?? 0 : 0;
          const text = observation
            ? `${observation.text}（探测于 ${new Date(observation.checkedAt).toISOString()}${fresh ? "" : "，已过期"}）`
            : "未探测";
          return { m, ok, text, busy, fresh };
        })));
      }
      for (const { m, ok, text, busy, fresh } of results) {
        const status = !m.enabled ? "停用" : !fresh ? "未知" : ok ? busy > 0 ? `繁忙 ${busy} 个任务` : "在线" : "离线";
        const ws = m.workspace ? `  工作区：${m.workspace}` : "  工作区：未设置";
        const paths = [
          ...(m.tunnelUrl ? [`公网隧道 ${m.tunnelUrl}`] : []),
          ...(m.paths ?? [{ kind: "direct" as const, host: m.host, port: m.port }])
            .map((p) => `${p.kind === "reverse" ? "反向" : "直连"} ${p.host}:${p.port}`),
        ].join(" / ");
        const rev = reverseStatus.get(m.id);
        const revText = rev
          ? `  反向隧道：${rev.connected ? `在线（空闲 ${rev.idleCount}/繁忙 ${rev.busyCount}）` : "离线"}\n    本地代理 127.0.0.1:${rev.proxyPort}`
          : "";
        const lastSeen = m.lastSeenAt ? new Date(m.lastSeenAt).toISOString() : "尚无记录";
        const version = m.lastAgentVersion ? `agent v${m.lastAgentVersion}` : "版本未知";
        const bundled = bundledAgentVersion();
        const upgrade = m.lastAgentVersion && m.lastAgentVersion !== bundled ? `（内置 v${bundled}，可重新部署；繁忙信息需 agent 1.5+）` : "";
        lines.push(`- ${m.id}${m.name !== m.id ? ` (${m.name})` : ""}  [${status}]${ws}\n    ${version}${upgrade}；最后在线 ${lastSeen}；自动探活 ${m.autoConnect ? "开" : "关"}\n    默认 cwd：${m.defaultCwd ?? m.workspace ?? "未选择"}\n    路径：${paths}${revText ? `\n${revText}` : ""}\n    ${text}`);
      }
      return lines.join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_machine_list");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_machine_add",
    description: "登记一台已部署 dsh-remote-agent 的远程机器。未提供 token 时自动生成（结果展示一次全量）。",
    parameters: {
      id: { type: "string", required: true, description: "机器唯一标识，如 office-pc。" },
      host: { type: "string", required: true, description: "目标机 IP 或主机名，如 192.168.1.20。" },
      port: { type: "integer", description: "agent 端口（默认 5188）。" },
      token: { type: "string", description: "与 agent --token 相同的共享密钥；留空则自动生成。" },
      token_sha256: { type: "string", description: "与 agent --token-sha256 相同的 64 位十六进制；与 token 二选一，该值本身也是可登录密钥。" },
      name: { type: "string", description: "备注名（默认同 id）。" },
      workspace: { type: "string", description: "可选：远程工作区绝对路径。" },
      auto_connect: { type: "boolean", description: "启动时自动探活，默认关闭；不会自动部署或执行命令。" },
      tunnel_url: { type: "string", description: "可选：公网隧道地址（如 https://xxx.trycloudflare.com），填了就走隧道，无需目标机入站端口。" },
    },
    output: textOut(),
    async execute(args: { id: string; host: string; port?: number; token?: string; token_sha256?: string; name?: string; workspace?: string; tunnel_url?: string; auto_connect?: boolean }) {
      const id = args.id.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return `错误：id 只允许字母数字和 . _ -（收到 "${id}"）。`;
      const existing = findMachine(id);
      if (args.token?.trim() && args.token_sha256?.trim()) throw new Error("token 与 token_sha256 不能同时提供。");
      const supplied = Boolean(args.token?.trim() || args.token_sha256?.trim());
      const generated = !supplied && !existing?.token && !existing?.tokenSha256;
      const token = args.token?.trim() || (args.token_sha256?.trim() ? "" : existing?.token || (generated ? newToken() : ""));
      const tokenSha256 = args.token_sha256?.trim().toLowerCase() || (args.token?.trim() ? undefined : existing?.tokenSha256);
      if (tokenSha256 && !/^[0-9a-f]{64}$/.test(tokenSha256)) return "错误：token_sha256 必须是 64 位十六进制。";
      const tunnelUrl = args.tunnel_url?.trim() ? normalizeTunnelUrl(args.tunnel_url) : undefined;
      if (args.tunnel_url?.trim() && !tunnelUrl) return "错误：tunnel_url 必须是 http(s):// 开头的地址，如 https://xxx.trycloudflare.com。";
      const registry = readRegistry();
      const machine: RemoteMachine = {
        ...existing,
        id,
        autoConnect: args.auto_connect ?? existing?.autoConnect ?? false,
        name: args.name?.trim() || existing?.name || id,
        host: args.host.trim(),
        port: args.port && args.port > 0 && args.port < 65536 ? Math.floor(args.port) : 5188,
        token,
        tokenSha256,
        enabled: true,
        workspace: args.workspace?.trim() || existing?.workspace,
        tunnelUrl: tunnelUrl ?? existing?.tunnelUrl,
        tokenCreatedAt: supplied || generated ? Date.now() : existing?.tokenCreatedAt,
      };
      ensureLocalWorkspace(machine);
      registry.machines = [...registry.machines.filter((m) => m.id !== id), machine];
      save(registry);
      const secretLine = tokenSha256
        ? `兼容哈希凭据：${tokenSha256.slice(0, 8)}…（该值仍须作为登录密钥保护）`
        : generated
          ? `共享 token（仅本次展示全量）：${token}`
          : `共享 token：${token.slice(0, 6)}…（已登记，不重复展示）`;
      return [
        `已登记机器：${id} → ${machine.host}:${machine.port}`,
        secretLine,
        ...(tunnelUrl ? [`公网隧道：${tunnelUrl}（优先走该地址，失败回退直连/反向）`] : []),
        `目标机启动 agent 时使用：node dsh-remote-agent.mjs --port ${machine.port} ${tokenSha256 ? "--token-sha256 <已保存的凭据>" : generated ? `--token ${token}` : "--token <已保存的密钥>"}`,
        `登记表：${registryPath}`,
      ].join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_machine_add");

  // ── 公网隧道（可选路径）───────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_tunnel",
    description: "为已登记机器设置/查看/清除公网隧道地址（如 Cloudflare quick tunnel）。地址变化时重新 set 即可，无需重装 agent。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      action: { type: "string", required: true, enum: ["set", "show", "clear"], description: "set=设置并验证；show=查看当前隧道与连通性；clear=清除隧道，回退直连/反向。" },
      url: { type: "string", description: "set 必填：隧道地址，如 https://xxx.trycloudflare.com。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; action: "set" | "show" | "clear"; url?: string }) {
      const { machine } = resolveTarget(args.machine);

      if (args.action === "clear") {
        updateMachine(machine.id, (m) => { m.tunnelUrl = undefined; });
        return `已清除机器 "${machine.id}" 的公网隧道，之后走直连/反向路径。`;
      }

      if (args.action === "set") {
        const tunnelUrl = normalizeTunnelUrl(args.url);
        if (!tunnelUrl) return "错误：url 必须是 http(s):// 开头的地址，如 https://xxx.trycloudflare.com。";
        updateMachine(machine.id, (m) => { m.tunnelUrl = tunnelUrl; });
        const probe = await probeAgentHttpUrl(tunnelUrl, 8_000);
        const online = probe.startsWith("agent-ok");
        let detail = "";
        if (online) {
          try {
            const health = await new RemoteClient({ ...machine, tunnelUrl }, 15_000).health(8_000);
            detail = `\n  目标机：${health.hostname} / ${health.platform} / agent v${health.version}`;
          } catch (error) {
            detail = `\n  /health 探测通过，但带 token 请求失败：${error instanceof Error ? error.message : String(error)}`;
          }
        }
        return [
          `已把机器 "${machine.id}" 的公网隧道设为：${tunnelUrl}`,
          `连通性：${probe}${detail}`,
          online
            ? "现在 remote_exec / remote_fs 等会优先走隧道，失败自动回退直连/反向。"
            : "隧道暂时不可用：确认目标机 cloudflared 正在运行、URL 未被刷新；稍后可 remote_tunnel(machine, action=show) 复测。",
          "隧道使用 90 秒同步执行、95 MiB 上传的保守阈值；服务商限制可能不同，长任务请用 remote_exec_bg。",
        ].join("\n");
      }

      const current = normalizeTunnelUrl(machine.tunnelUrl);
      if (!current) return `机器 "${machine.id}" 未配置公网隧道（走 ${machine.host}:${machine.port}）。`;
      const probe = await probeAgentHttpUrl(current, 8_000);
      return [
        `机器 "${machine.id}" 的公网隧道：${current}`,
        `连通性：${probe}`,
        "如需更换地址：remote_tunnel(machine, action=set, url=https://…)。",
      ].join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_tunnel");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_machine_remove",
    description: "移除机器登记；在线或繁忙机器需 force=true，移除不会终止远程任务。",
    parameters: {
      id: { type: "string", required: true, description: "机器 id。" },
      force: { type: "boolean", description: "显式移除在线机器；不会卸载 agent 或结束任务。" },
    },
    output: textOut(),
    async execute(args: { id: string; force?: boolean }) {
      return removeMachine(args.id, args.force === true);
    },
  })), "@dsh-external/dsh-remote-control: remote_machine_remove");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_machine_configure",
    description: "配置指定远程电脑的显示名、启用状态、启动探活、默认 cwd/env；cwd 会在线验证为目录。不会改变其他机器或运行命令。",
    parameters: {
      machine: { type: "string", required: true, description: "稳定机器 id；改名不改变 id。" },
      name: { type: "string", description: "显示名。" },
      enabled: { type: "boolean", description: "停用后所有远程操作被拒绝。" },
      auto_connect: { type: "boolean", description: "插件启动时自动探活，默认关闭，不会执行命令。" },
      default_cwd: { type: "string", description: "默认工作目录，绝对路径或相对已选工作区；空字符串恢复使用工作区。" },
      default_env: { type: "json", description: "默认环境变量字符串对象；调用时 env 优先；{} 清除。不要在这里保存密码/token。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; name?: string; enabled?: boolean; auto_connect?: boolean; default_cwd?: string; default_env?: unknown }) {
      const { machine } = resolveTarget(args.machine);
      if (args.name !== undefined && !args.name.trim()) throw new Error("显示名不能为空。");
      const env = args.default_env !== undefined ? validateDefaultEnv(args.default_env) : undefined;
      let cwd = machine.defaultCwd;
      if (args.default_cwd !== undefined) {
        cwd = args.default_cwd.trim() || undefined;
        if (cwd) {
          const target = executionDefaults({ ...machine, enabled: true }, cwd).cwd;
          const stat = await new RemoteClient({ ...machine, enabled: true }, cfg.defaultTimeoutMs).fs("stat", { path: target }) as { exists?: boolean; type?: string };
          if (!stat.exists || stat.type !== "directory") throw new Error(`默认工作目录不存在或不是目录：${target}`);
          cwd = target;
        }
      }
      const updated = updateMachine(machine.id, (m) => {
        if (args.name !== undefined) m.name = args.name.trim();
        if (args.enabled !== undefined) m.enabled = args.enabled;
        if (args.auto_connect !== undefined) m.autoConnect = args.auto_connect;
        if (args.default_cwd !== undefined) m.defaultCwd = cwd;
        if (env !== undefined) m.defaultEnv = env;
      });
      catalog.forget(machine.id);
      return `已配置 ${updated.id} (${updated.name})\n启用：${updated.enabled}；启动探活：${Boolean(updated.autoConnect)}\n默认 cwd：${updated.defaultCwd ?? updated.workspace ?? "未选择工作区"}\n默认环境变量名称：${Object.keys(updated.defaultEnv ?? {}).join(", ") || "无"}（不回显值）`;
    },
  })), "dsh-remote-control: remote_machine_configure");

  // ── 远程工作区 ────────────────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_workspace",
    description: "在远程机器上浏览/创建/选定文件夹作为工作区；设置后 exec/fs/上传下载的相对路径都基于它。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      operation: { type: "string", required: true, enum: ["list", "create", "set"], description: "list=浏览目录；create=创建目录；set=创建(可选)并设为工作区。" },
      path: { type: "string", description: "绝对路径；list 缺省时显示当前工作区或用户主目录。" },
      create: { type: "boolean", description: "set 时目录不存在是否自动创建（默认 true）。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; operation: "list" | "create" | "set"; path?: string; create?: boolean }) {
      const client = clientFor(args.machine);
      const machine = client.machine;
      const op = args.operation;

      if (op === "list") {
        let dir: string;
        if (args.path) {
          dir = resolveRemotePath(machine, args.path, "list");
        } else if (machine.workspace) {
          dir = machine.workspace;
        } else {
          const info = await client.sysinfo();
          dir = info.homedir || "/";
        }
        const data = await client.fs("list", { path: dir });
        const entries = Array.isArray(data) ? data as Array<{ name: string; type: string; sizeBytes?: number; mtimeMs?: number }> : [];
        const lines = [`目录：${dir}${machine.workspace === dir ? "（当前工作区）" : ""}`];
        if (entries.length === 0) lines.push("（空目录）");
        for (const e of entries.slice(0, 300)) {
          const size = e.type === "file" && e.sizeBytes !== undefined ? `  ${e.sizeBytes} B` : "";
          lines.push(`- ${e.type === "directory" ? "📁" : "📄"} ${e.name}${size}`);
        }
        if (entries.length > 300) lines.push(`… 共 ${entries.length} 项，仅显示前 300 项。`);
        if (!machine.workspace) lines.push("提示：用 remote_workspace(operation=set, path=<绝对路径>) 将某个目录设为工作区。");
        return lines.join("\n");
      }

      const target = resolveRemotePath(machine, args.path ?? ".", "workspace");
      if (op === "create") {
        await client.fs("mkdir", { path: target, recursive: true });
        return `已创建目录：${target}。如需设为工作区：remote_workspace(operation=set, path="${target}")`;
      }

      const createIfMissing = args.create !== false;
      if (createIfMissing) await client.fs("mkdir", { path: target, recursive: true });
      if (!isRemoteAbsolute(target)) throw new Error("工作区必须是远程电脑上的绝对路径。");
      const stat = await client.fs("stat", { path: target }) as { exists?: boolean; type?: string };
      if (!stat.exists || stat.type !== "directory") throw new Error(`工作区不存在或不是目录：${target}`);
      const updated = updateMachine(machine.id, (m) => { m.workspace = target; m.defaultCwd = undefined; });
      return [
        `已将机器 "${machine.id}" 的远程工作区设为：${target}`,
        `之后 remote_exec 的默认目录、remote_fs/remote_upload/remote_download 的相对路径都基于它。`,
        updated.workspace === target ? "登记表已保存。" : "登记表保存失败。",
      ].join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_workspace");

  // ── 远程执行 ─────────────────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_exec",
    description: "在指定远程机器上执行 shell 命令（Windows 为 cmd.exe /c，Linux/macOS 为 sh -c），返回退出码/stdout/stderr。",
    parameters: {
      machine: { type: "string", description: "机器 id，见 remote_machine_list；省略则使用当前选定的电脑。" },
      command: { type: "string", required: true, description: "要执行的完整命令；可 powershell -Command 或 bash -lc 包裹。" },
      cwd: { type: "string", description: "工作目录；相对路径基于机器工作区，缺省即工作区。" },
      timeout_ms: { type: "integer", description: "超时毫秒数（默认 120000，超时后 agent 会杀掉整个进程树）。" },
      env: { type: "json", description: "附加环境变量对象，如 {\"CI\":\"1\"}。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; command: string; cwd?: string; timeout_ms?: number; env?: unknown }) {
      const client = clientFor(args.machine);
      const machine = client.machine;
      const { cwd, env } = executionDefaults(machine, args.cwd, normalizeEnv(args.env));
      const result = await client.exec(args.command, {
        cwd,
        env,
        timeoutMs: args.timeout_ms ?? config.defaultTimeoutMs,
      });
      const requested = args.timeout_ms ?? config.defaultTimeoutMs;
      const effective = client.effectiveExecTimeout(requested);
      const tunnelNote = machine.tunnelUrl && effective < requested
        ? `提示：该机器配置了公网隧道，按插件保守策略，超时已从 ${requested}ms 降到 ${effective}ms；更长的命令请用 remote_exec_bg。\n`
        : "";
      return tunnelNote + `远程工作目录：${cwd}\n` + formatExecResult(client, result, args.command);
    },
  })), "@dsh-external/dsh-remote-control: remote_exec");

  // ── 远程后台任务（长命令不占 HTTP 请求）──────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_exec_bg",
    description: "在远程机器后台执行长命令（构建/测试/长脚本），立即返回任务 id；之后用 remote_job 轮询输出或结束，不受单次请求超时限制。",
    parameters: {
      machine: { type: "string", description: "机器 id，见 remote_machine_list；省略则使用当前选定的电脑。" },
      command: { type: "string", required: true, description: "要后台执行的完整命令。" },
      cwd: { type: "string", description: "工作目录；相对路径基于机器工作区，缺省即工作区。" },
      timeout_ms: { type: "integer", description: "可选：任务超时毫秒数（默认不限时；超时后结束整个进程树）。" },
      env: { type: "json", description: "附加环境变量对象，如 {\"CI\":\"1\"}。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; command: string; cwd?: string; timeout_ms?: number; env?: unknown }) {
      const client = clientFor(args.machine);
      const machine = client.machine;
      const { cwd, env } = executionDefaults(machine, args.cwd, normalizeEnv(args.env));
      const job = await client.startJob(args.command, {
        cwd,
        env,
        timeoutMs: args.timeout_ms,
      });
      return [
        `已在 ${machine.id} 启动后台任务：${job.id}`,
        `命令：${job.command.length > 300 ? `${job.command.slice(0, 300)}…` : job.command}`,
        `工作目录：${job.cwd ?? "(继承 agent 进程)"}`,
        `查看输出：remote_job(machine="${machine.id}", action="output", job_id="${job.id}")`,
        `结束任务：remote_job(machine="${machine.id}", action="kill", job_id="${job.id}")`,
        "任务在目标机上独立运行；agent 重启会结束未完成的任务。",
      ].join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_exec_bg");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_job",
    description: "管理远程后台任务：list 列出全部任务，status 看单个状态，output 看 stdout/stderr，kill 结束整个进程树。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      action: { type: "string", required: true, enum: ["list", "status", "output", "kill"], description: "list / status / output / kill。" },
      job_id: { type: "string", description: "status/output/kill 必填：remote_exec_bg 返回的任务 id。" },
      tail_chars: { type: "integer", description: "output 时每条流最多显示的字符数（默认 20000）。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; action: "list" | "status" | "output" | "kill"; job_id?: string; tail_chars?: number }) {
      const client = clientFor(args.machine);
      if (args.action === "list") {
        const jobs = await client.listJobs();
        if (jobs.length === 0) return `机器 ${client.machine.id} 上没有后台任务。用 remote_exec_bg 启动。`;
        const lines = [`后台任务（${jobs.length} 个；已完成任务保留 1 小时，最多 64 个）：`];
        for (const job of jobs.slice(0, 50)) {
          lines.push(`- ${job.id}  ${formatJobStatus(job)}\n  命令：${job.command.length > 120 ? `${job.command.slice(0, 120)}…` : job.command}`);
        }
        if (jobs.length > 50) lines.push(`… 仅显示前 50 个，共 ${jobs.length} 个。`);
        return lines.join("\n");
      }

      const jobId = args.job_id?.trim();
      if (!jobId) return `错误：action=${args.action} 需要 job_id。`;
      if (args.action === "kill") {
        const result = await client.killJob(jobId);
        return `任务 ${result.id}：${result.message}（killed=${result.killed}）`;
      }
      if (args.action === "status") {
        const jobs = await client.listJobs();
        const job = jobs.find((item) => item.id === jobId);
        if (!job) return `错误：任务 "${jobId}" 不存在（可能已清理，用 action=list 查看）。`;
        return [
          `任务：${job.id}`,
          formatJobStatus(job),
          `命令：${job.command}`,
          `工作目录：${job.cwd ?? "(继承 agent 进程)"}`,
        ].join("\n");
      }

      const output: JobOutput = await client.jobOutput(jobId);
      const limit = Math.max(1000, Math.min(args.tail_chars ?? 20_000, 100_000));
      const tail = (text: string) =>
        text.length > limit ? `…（仅显示最后 ${limit} 字符）\n${text.slice(-limit)}` : text;
      const parts = [
        `任务：${output.id}`,
        formatJobStatus(output),
        `命令：${output.command.length > 500 ? `${output.command.slice(0, 500)}…` : output.command}`,
      ];
      parts.push(`--- stdout ---\n${output.stdout ? tail(output.stdout) : "(空)"}`);
      if (output.stderr) parts.push(`--- stderr ---\n${tail(output.stderr)}`);
      if (output.running) parts.push("任务仍在运行：稍后再取一次 output 即可看到增量（输出为当前缓冲全量）。");
      return parts.join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_job");

  // ── 远程文件系统 ─────────────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_fs",
    description: "操作远程机器的文件系统：list/stat/read/write/append/mkdir/delete/rename；相对路径基于机器工作区。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      operation: { type: "string", required: true, enum: ["list", "stat", "read", "write", "append", "mkdir", "delete", "rename"], description: "操作类型。" },
      path: { type: "string", required: true, description: "远程路径（绝对路径，或相对工作区）。" },
      content: { type: "string", description: "write/append 的文件内容（UTF-8）。" },
      new_path: { type: "string", description: "rename 的新路径（同样支持相对工作区）。" },
      encoding: { type: "string", enum: ["utf8", "base64"], description: "read/write/append 的编码（默认 utf8）。" },
      recursive: { type: "boolean", description: "mkdir/delete 是否递归（默认 false）。" },
    },
    output: textOut(),
    async execute(args: {
      machine?: string; operation: string; path: string; content?: string;
      new_path?: string; encoding?: "utf8" | "base64"; recursive?: boolean;
    }) {
      const client = clientFor(args.machine);
      const machine = client.machine;
      const op = args.operation;
      const payload: Record<string, unknown> = {
        path: resolveRemotePath(machine, args.path, op),
        encoding: args.encoding ?? "utf8",
        content: args.content,
        newPath: args.new_path ? resolveRemotePath(machine, args.new_path, "rename") : undefined,
        recursive: args.recursive === true,
      };
      const data = await client.fs(op, payload);
      if (op === "read" && (args.encoding ?? "utf8") === "utf8" && data && typeof data === "object") {
        const read = data as { content?: string; truncated?: boolean; path?: string; sizeBytes?: number };
        return `${read.truncated ? `（输出已截断，sizeBytes=${read.sizeBytes}）\n` : ""}${read.content ?? ""}`;
      }
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    },
  })), "@dsh-external/dsh-remote-control: remote_fs");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_upload",
    description: "把本机文件上传到远程机器；远程相对路径基于机器工作区。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      local_path: { type: "string", required: true, description: "本机文件路径。" },
      remote_path: { type: "string", required: true, description: "远程目标路径（含文件名；可相对工作区）。" },
      timeout_ms: { type: "integer", description: "超时毫秒数（大文件建议调大，默认 120000）。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; local_path: string; remote_path: string; timeout_ms?: number }) {
      const client = clientFor(args.machine);
      const machine = client.machine;
      const remotePath = resolveRemotePath(machine, args.remote_path, "上传");
      const result = await client.upload(args.local_path, remotePath, { timeoutMs: args.timeout_ms ?? config.defaultTimeoutMs });
      return `已上传 ${args.local_path} → ${client.machine.id}:${remotePath}（${result.sizeBytes} 字节）`;
    },
  })), "@dsh-external/dsh-remote-control: remote_upload");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_download",
    description: "把远程机器上的文件下载到本机；远程相对路径基于机器工作区。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      remote_path: { type: "string", required: true, description: "远程文件路径（可相对工作区）。" },
      local_path: { type: "string", required: true, description: "本机保存路径（目录会自动创建）。" },
      timeout_ms: { type: "integer", description: "超时毫秒数（大文件建议调大，默认 120000）。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; remote_path: string; local_path: string; timeout_ms?: number }) {
      const client = clientFor(args.machine);
      const machine = client.machine;
      const remotePath = resolveRemotePath(machine, args.remote_path, "下载");
      const result = await client.download(remotePath, args.local_path, { timeoutMs: args.timeout_ms ?? config.defaultTimeoutMs });
      return `已下载 ${client.machine.id}:${remotePath} → ${result.localPath}（${result.sizeBytes} 字节）`;
    },
  })), "@dsh-external/dsh-remote-control: remote_download");

  // ── 系统信息与进程 ────────────────────────────────────────────────────────
  ctx.effect(() => registerTool(defineTool({
    name: "remote_sysinfo",
    description: "读取远程机器的系统信息（系统版本/CPU/内存/负载/运行时长等）。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
    },
    output: textOut(),
    async execute(args: { machine?: string }) {
      const client = clientFor(args.machine);
      const info = await client.sysinfo();
      return formatSysinfo(client, info);
    },
  })), "@dsh-external/dsh-remote-control: remote_sysinfo");

  ctx.effect(() => registerTool(defineTool({
    name: "remote_processes",
    description: "列出远程机器进程，或按 pid 结束远程进程（kill 会结束整个进程树）。",
    parameters: {
      machine: { type: "string", description: "机器 id；省略则使用输入框上方指示器选定的电脑。" },
      action: { type: "string", required: true, enum: ["list", "kill"], description: "list 或 kill。" },
      pid: { type: "integer", description: "kill 时的目标进程 id。" },
    },
    output: textOut(),
    async execute(args: { machine?: string; action: "list" | "kill"; pid?: number }) {
      const client = clientFor(args.machine);
      if (args.action === "kill") {
        if (!Number.isInteger(args.pid) || (args.pid as number) <= 0) return "错误：kill 需要正整数 pid。";
        const result = await client.killProcess(args.pid as number);
        return `pid ${result.pid}：${result.message}（killed=${result.killed}）`;
      }
      const processes = await client.processes();
      const lines = [`远程进程（${processes.length} 个，pid/name/cmd）：`];
      for (const p of processes.slice(0, 200)) {
        lines.push(`- ${p.pid}${p.ppid !== undefined ? ` (ppid ${p.ppid})` : ""}  ${p.name}${p.cmd ? `  ${p.cmd.slice(0, 160)}` : ""}`);
      }
      if (processes.length > 200) lines.push(`… 仅显示前 200 个，共 ${processes.length} 个。`);
      return lines.join("\n");
    },
  })), "@dsh-external/dsh-remote-control: remote_processes");

  // ── 设置页「远程控制」面板 API（client.js 调用；与工具共用同一登记表）─────────
  ctx.effect(() => {
    const server = (ctx as Context & { webServer?: { register?: (spec: unknown) => unknown } }).webServer;
    if (!server || typeof server.register !== "function") return () => {};
    const send = (res: import("node:http").ServerResponse, code: number, obj: unknown) => {
      try {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
      } catch {
        // 响应已发送。
      }
    };
    return (server.register({
      kind: "prefix",
      path: "/dsh-remote-control/api",
      handler: async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const pathname = url.pathname.replace(/^\/dsh-remote-control\/api/, "") || "/";
          const method = req.method ?? "GET";
          // This route has no shared DSH authentication hook. Keep configuration local-only,
          // including when the main web UI is exposed by a tunnel or reverse proxy.
          const peer = req.socket?.remoteAddress;
          const localPeer = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
          let localHost = false;
          try { localHost = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${req.headers?.host ?? ""}`).hostname); } catch { /* fail closed */ }
          const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "x-dsh-internal-tunnel"]
            .some((header) => req.headers?.[header] !== undefined);
          if (!localPeer || !localHost || forwarded) {
            return send(res, 403, { ok: false, error: "远程控制设置接口仅允许本机访问；请在本机 GUI 配置，远程使用 DSH 对话工具。" });
          }
          if (method !== "GET") {
            const origin = req.headers?.origin;
            const host = req.headers?.host;
            if (req.headers?.["sec-fetch-site"] === "cross-site" ||
                origin && (!host || new URL(origin).host !== host)) {
              return send(res, 403, { ok: false, error: "拒绝跨站设置变更" });
            }
          }

          if (method === "GET" && pathname === "/state") {
            const registry = readRegistry();
            const active = registry.activeMachineId
              ? registry.machines.find((m) => m.id === registry.activeMachineId)
              : undefined;
            return send(res, 200, {
              ok: true,
              active: active
                ? {
                    id: active.id, name: active.name,
                    workspace: active.defaultCwd || active.workspace || null,
                    platform: active.platform ?? null,
                    enabled: active.enabled,
                  }
                : null,
              machines: registry.machines.map((m) => ({
                id: m.id, name: m.name, enabled: m.enabled,
                workspace: m.defaultCwd || m.workspace || null,
              })),
            });
          }

          if (method === "POST" && pathname === "/activate") {
            const body = JSON.parse(await readHttpBody(req) || "{}") as Record<string, unknown>;
            const raw = body.machine === undefined || body.machine === null ? "" : String(body.machine).trim();
            const registry = readRegistry();
            if (!raw) {
              registry.activeMachineId = undefined;
              save(registry);
              return send(res, 200, { ok: true, active: null });
            }
            const machine = registry.machines.find((m) => m.id === raw);
            if (!machine) return send(res, 404, { ok: false, error: `机器 "${raw}" 未登记` });
            registry.activeMachineId = machine.id;
            save(registry);
            return send(res, 200, {
              ok: true,
              active: {
                id: machine.id, name: machine.name,
                workspace: machine.defaultCwd || machine.workspace || null,
                platform: machine.platform ?? null, enabled: machine.enabled,
              },
            });
          }

          if (method === "GET" && pathname === "/machines") {
            const machines = readRegistry().machines.map(sanitizeMachine);
            return send(res, 200, { ok: true, machines, registryPath });
          }

          if (method === "POST" && pathname === "/save") {
            const body = JSON.parse(await readHttpBody(req) || "{}") as Record<string, unknown>;
            const id = String(body.id ?? "").trim() || `pc-${String(body.host ?? "").replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(0, 64);
            const host = String(body.host ?? "").trim();
            const username = String(body.username ?? "").trim();
            const password = String(body.password ?? "");
            if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return send(res, 400, { ok: false, error: "id 只允许字母数字和 . _ -" });
            if (!/^[A-Za-z0-9._-]{1,253}$/.test(host)) return send(res, 400, { ok: false, error: "host 应为 IP 或主机名" });
            if (!username) return send(res, 400, { ok: false, error: "username 必填" });
            const osHint = body.os === "windows" || body.os === "linux" ? body.os : "auto";
            const existing = findMachine(id);
            const tunnelUrlRaw = String(body.tunnelUrl ?? "").trim();
            const tunnelUrl = tunnelUrlRaw ? normalizeTunnelUrl(tunnelUrlRaw) : existing?.tunnelUrl;
            if (tunnelUrlRaw && !tunnelUrl) return send(res, 400, { ok: false, error: "tunnelUrl 必须是 http(s):// 地址，如 https://xxx.trycloudflare.com" });
            const registry = readRegistry();
            const machine: RemoteMachine = {
              ...(existing ?? {
                id, name: id, host, port: 5188, token: newToken(), enabled: true, tokenCreatedAt: Date.now(),
              }),
              id, name: String(body.name ?? "").trim() || existing?.name || id,
              host,
              port: typeof body.port === "number" && body.port > 0 && body.port < 65536 ? Math.floor(body.port) : (existing?.port ?? 5188),
              username, password, osHint,
              tunnelUrl,
              autoConnect: typeof body.autoConnect === "boolean" ? body.autoConnect : existing?.autoConnect ?? false,
              localWorkspace: String(body.localWorkspace ?? "").trim() || existing?.localWorkspace || undefined,
            };
            ensureLocalWorkspace(machine);
            registry.machines = [...registry.machines.filter((m) => m.id !== id), machine];
            save(registry);
            return send(res, 200, { ok: true, machine: sanitizeMachine(machine) });
          }

          if (method === "POST" && pathname === "/connect") {
            const body = JSON.parse(await readHttpBody(req) || "{}") as Record<string, unknown>;
            const stored = body.id ? findMachine(String(body.id).trim()) : undefined;
            const host = String(body.host ?? stored?.host ?? "").trim();
            const username = String(body.username ?? stored?.username ?? "").trim();
            const password = String(body.password ?? stored?.password ?? "");
            const os = body.os === "windows" || body.os === "linux" ? body.os : (stored?.osHint ?? "auto");
            if (!host) return send(res, 400, { ok: false, error: "host 必填" });
            if (!username) return send(res, 400, { ok: false, error: "username 必填（或在面板中已保存）" });
            // 密码允许为空：部分电脑未设置密码。Windows 空密码网络登录是否放行由目标机策略决定。
            // 工具参数必须是 lossless JSON：只放有值的字段，绝不传 undefined。
            const toolArgs: Record<string, unknown> = {
              id: String(body.id ?? "").trim() || `pc-${host.replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(0, 64),
              host,
              username,
              password,
              os,
            };
            if (typeof body.port === "number" && Number.isFinite(body.port)) toolArgs.agent_port = body.port;
            if (typeof body.name === "string" && body.name.trim()) toolArgs.name = body.name.trim();
            if (typeof body.workspace === "string" && body.workspace.trim()) toolArgs.workspace = body.workspace.trim();
            if (typeof body.controller_host === "string" && body.controller_host.trim()) toolArgs.controller_host = body.controller_host.trim();
            const result = await (connectToolDef.execute as (a: unknown, e: unknown) => Promise<string>)(toolArgs, {});
            return send(res, 200, { ok: true, result });
          }

          if (method === "POST" && pathname === "/probe") {
            const body = JSON.parse(await readHttpBody(req) || "{}") as Record<string, unknown>;
            const machine = findMachine(String(body.id ?? "").trim());
            if (!machine) return send(res, 404, { ok: false, error: "机器未登记" });
            try {
              const status = await catalog.probe(machine, cfg.healthProbeTimeoutMs, body.refresh === true);
              return send(res, 200, {
                ok: true, online: status.online, text: status.text,
                busyJobs: status.health?.runningJobs ?? 0,
                checkedAt: status.checkedAt,
                workspace: findMachine(machine.id)?.workspace,
              });
            } catch (error) {
              return send(res, 200, { ok: true, online: false, text: error instanceof Error ? error.message : String(error) });
            }
          }

          if (method === "POST" && pathname === "/remove") {
            const body = JSON.parse(await readHttpBody(req) || "{}") as Record<string, unknown>;
            const id = String(body.id ?? "").trim();
            if (!findMachine(id)) return send(res, 404, { ok: false, error: "机器未登记" });
            const result = await removeMachine(id, body.force === true);
            if (!result.startsWith("已移除")) return send(res, 409, { ok: false, error: result });
            try {
              const registry = readRegistry();
              if (registry.activeMachineId === id) { registry.activeMachineId = undefined; save(registry); }
            } catch { /* best effort */ }
            return send(res, 200, { ok: true, result });
          }

          return send(res, 404, { ok: false, error: `not found: ${method} ${pathname}` });
        } catch (error) {
          return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    })) as unknown as () => void;
  }, "@dsh-external/dsh-remote-control: settings-panel-api");
}

// ── 格式化辅助 ─────────────────────────────────────────────────────────────

function normalizeEnv(env: unknown): Record<string, string> | undefined {
  if (!env) return undefined;
  if (typeof env !== "object" || Array.isArray(env)) throw new Error("env 必须是对象，如 {\"CI\":\"1\"}。");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

function formatJobStatus(job: JobInfo): string {
  const seconds = (job.durationMs / 1000).toFixed(1);
  const state = job.running
    ? "运行中"
    : job.timedOut
      ? "超时结束"
      : job.exitCode === 0
        ? "成功"
        : `结束（退出码 ${job.exitCode ?? "无"}${job.signal ? `，信号 ${job.signal}` : ""}）`;
  const icon = job.running ? "⏳" : job.exitCode === 0 ? "✅" : "⚠️";
  const buffers = `stdout ${job.stdoutBytes}B / stderr ${job.stderrBytes}B${job.truncated ? "（已截断）" : ""}`;
  return `${icon} ${state}  耗时 ${seconds}s  ${buffers}`;
}

function formatExecResult(client: RemoteClient, r: ExecResult, fallbackCommand?: string): string {
  const command = r.command || fallbackCommand || "(未知命令)";
  const head = [
    `机器：${client.machine.name} (${client.machine.host}:${client.machine.port})`,
    `命令：${command.length > 800 ? command.slice(0, 800) + "…(截断)" : command}`,
    `退出码：${r.exitCode ?? "无"}${r.signal ? `  信号：${r.signal}` : ""}  耗时：${r.durationMs}ms${r.timedOut ? "  [已超时]" : ""}${r.truncated ? "  [输出已截断]" : ""}`,
  ];
  const parts = [...head];
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  return parts.join("\n");
}

function formatSysinfo(client: RemoteClient, info: SysInfo): string {
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + " GB";
  return [
    `机器：${client.machine.name} (${client.machine.host}:${client.machine.port})`,
    `主机名：${info.hostname}  用户：${info.user}`,
    `系统：${info.osType} ${info.release} (${info.platform}/${info.arch})  Node ${info.nodeVersion}  agent v${info.agentVersion}`,
    `CPU：${info.cpus.model} × ${info.cpus.count}`,
    `内存：${gb(info.memFreeBytes)} 可用 / ${gb(info.memTotalBytes)} 总量`,
    `负载：${info.loadAvg.join(" / ")}  运行时长：${Math.floor(info.uptimeSec / 86400)}天${Math.floor((info.uptimeSec % 86400) / 3600)}小时`,
  ].join("\n");
}
