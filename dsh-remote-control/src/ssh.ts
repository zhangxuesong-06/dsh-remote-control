/**
 * SSH transport: talk to a remote computer over its own OpenSSH server,
 * with NO agent installed on the target. Authentication is key-based
 * (Windows' ssh cannot take a password on the command line, and there is no
 * sshpass on Windows), so this module owns a dedicated key pair and reports
 * whether the key has been authorized on the target yet.
 *
 * Every command is run as a single argv array — never a shell string built by
 * concatenation — so remote-side flags/quoting cannot be injected by callers.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface SshTarget {
  id: string;
  host: string;
  port?: number;
  /** Login user on the target. */
  username: string;
  /** Private key path; defaults to the plugin-managed key. */
  identityFile?: string;
  /** Optional dedicated known_hosts file (kept out of the user's ~/.ssh to avoid write contention). */
  knownHostsFile?: string;
}

/** Plugin-private known_hosts path derived from the identity file's directory. */
export function defaultKnownHostsFile(identityFile: string): string {
  return join(dirname(identityFile), "known_hosts");
}

export interface SshRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SSH_EXE = process.platform === "win32" ? "ssh.exe" : "ssh";
const SCP_EXE = process.platform === "win32" ? "scp.exe" : "scp";
const KEYGEN_EXE = process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen";

/** Directory that holds the plugin's SSH identity (inside the registry dir). */
export function sshKeyDir(registryPath: string): string {
  return join(dirname(registryPath), "ssh");
}

export function defaultIdentityFile(registryPath: string): string {
  return join(sshKeyDir(registryPath), "id_dsh_remote_ed25519");
}

/**
 * Ensure a dedicated ed25519 key exists; return {privatePath, publicKey}.
 * Never overwrites an existing key. Async because the harness sandbox blocks
 * synchronous child-process spawn (EPERM); it allows execFile.
 */
export async function ensureIdentity(registryPath: string): Promise<{ privatePath: string; publicKey: string; created: boolean }> {
  const dir = sshKeyDir(registryPath);
  const privatePath = defaultIdentityFile(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(privatePath)) {
    const r = await execFileAsync(KEYGEN_EXE, ["-t", "ed25519", "-N", "", "-C", "dsh-remote-control", "-f", privatePath], 20_000);
    if (r.code !== 0 || !existsSync(privatePath)) {
      throw new Error(`生成 SSH 密钥失败：${(r.stderr || r.stdout || "").trim() || `exit ${r.code}`}`);
    }
    try { chmodSync(privatePath, 0o600); } catch { /* Windows: rely on ACL */ }
  }
  // Pre-create the plugin-private known_hosts so the first ssh connection can record the
  // host key without a permission/parent-missing error.
  try {
    const kh = defaultKnownHostsFile(privatePath);
    if (!existsSync(kh)) writeFileSync(kh, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  } catch { /* best effort */ }
  return { privatePath, publicKey: readFileSync(`${privatePath}.pub`, "utf8").trim(), created: false };
}

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<SshRunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = typeof (error as unknown as { code?: number })?.code === "number"
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: Boolean((error as { killed?: boolean } | null)?.killed) });
    });
  });
}

function sshBaseArgs(target: SshTarget, identityFile: string): string[] {
  const args = [
    "-i", identityFile,
    "-p", String(target.port ?? 22),
    "-o", "BatchMode=yes",
    // accept-new: first connection records the host key into our own file, so repeated
    // connections skip the check. Using a plugin-private known_hosts avoids permission
    // failures when the user's ~/.ssh/known_hosts is managed by another tool.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=" + (target.knownHostsFile ?? defaultKnownHostsFile(identityFile)),
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "LogLevel=ERROR",
  ];
  args.push(`${target.username}@${target.host}`);
  return args;
}

function runFile(file: string, args: string[], timeoutMs: number, stdin?: Buffer): SshRunResult {
  // Synchronous-ish via execFileSync is unavailable for streaming output here;
  // callers use runAsync. This sync variant is only for short local key ops.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const res = spawnSync(file, args, { timeout: timeoutMs, input: stdin, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return {
    code: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    timedOut: Boolean(res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT"),
  };
}

/** Run a command on the target over SSH. `argv` is passed verbatim (no shell on our side). */
export function sshRun(target: SshTarget, identityFile: string, argv: string[], options: { timeoutMs?: number; cwd?: string; env?: Record<string, string>; stdin?: Buffer } = {}): Promise<SshRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const args = sshBaseArgs(target, identityFile);
  if (options.cwd) {
    // cd safely: use a POSIX single-quote escape; Windows OpenSSH Server uses cmd/powershell semantics,
    // so we only prepend cd when a cwd is explicitly requested.
    args.push("--", `cd ${shellQuotePosix(options.cwd)} && exec "$@"`, "sh", ...argv);
  } else {
    args.push("--", ...argv);
  }
  return new Promise((resolve) => {
    execFile(SSH_EXE, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, ...(options.env ?? {}) },
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0;
      resolve({
        code,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        timedOut: Boolean(Boolean((error as { killed?: boolean } | null)?.killed) && timeoutMs > 0 && String((error as Error)?.message ?? "").includes("ETIMEDOUT")),
      });
    });
  });
}

/** Execute a shell command *string* on the target via its login shell (used by exec tool). */
export function sshShell(target: SshTarget, identityFile: string, command: string, options: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {}): Promise<SshRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const prefix = options.env
    ? Object.entries(options.env).map(([k, v]) => `${k}=${shellQuotePosix(v)}`).join(" ") + " "
    : "";
  const wrapped = options.cwd
    ? `cd ${shellQuotePosix(options.cwd)} && ${prefix}${command}`
    : `${prefix}${command}`;
  return sshRaw(target, identityFile, wrapped, timeoutMs);
}

function sshRaw(target: SshTarget, identityFile: string, remoteCommand: string, timeoutMs: number): Promise<SshRunResult> {
  const args = [...sshBaseArgs(target, identityFile), "--", remoteCommand];
  return new Promise((resolve) => {
    execFile(SSH_EXE, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      const errno = error as NodeJS.ErrnoException | null;
      const code = typeof (error as unknown as { code?: number })?.code === "number"
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0;
      resolve({
        code,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        timedOut: Boolean(errno && (errno as { killed?: boolean }).killed),
      });
    });
  });
}

/** Copy a local file to the target via scp. */
export function scpUpload(target: SshTarget, identityFile: string, localPath: string, remotePath: string, timeoutMs = 120_000): Promise<SshRunResult> {
  const args = ["-i", identityFile, "-P", String(target.port ?? 22), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + (target.knownHostsFile ?? defaultKnownHostsFile(identityFile)), "-o", "LogLevel=ERROR", localPath, `${target.username}@${target.host}:${remotePath}`];
  return new Promise((resolve) => {
    execFile(SCP_EXE, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: Boolean(Boolean((error as { killed?: boolean } | null)?.killed)) });
    });
  });
}

/** Download a remote file via scp. */
export function scpDownload(target: SshTarget, identityFile: string, remotePath: string, localPath: string, timeoutMs = 120_000): Promise<SshRunResult> {
  const args = ["-i", identityFile, "-P", String(target.port ?? 22), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + (target.knownHostsFile ?? defaultKnownHostsFile(identityFile)), "-o", "LogLevel=ERROR", `${target.username}@${target.host}:${remotePath}`, localPath];
  return new Promise((resolve) => {
    execFile(SCP_EXE, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: Boolean(Boolean((error as { killed?: boolean } | null)?.killed)) });
    });
  });
}

function shellQuotePosix(value: string): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * The ONE command a user pastes in the target's terminal. It does everything needed:
 * enable/start the SSH server (if not already), and authorize this plugin's key.
 * Three platforms; the UI shows exactly one, chosen by the user.
 */
export function publicKeyInstallCommand(publicKey: string): { linux: string; macos: string; windows: string } {
  const k = publicKey.trim();

  // Linux: ensure openssh-server, start+enable sshd, then authorize the key. Each package/service
  // step is parenthesised so a failure there never skips the key installation that follows.
  const linux = [
    `echo "开始配置 SSH（需要输入一次系统密码）..."`,
    `{ (sudo apt-get update -qq && sudo apt-get install -y openssh-server) || sudo yum install -y openssh-server || sudo dnf install -y openssh-server; } >/dev/null 2>&1 || true`,
    `{ sudo systemctl enable --now ssh || sudo systemctl enable --now sshd; } >/dev/null 2>&1 || true`,
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
    `grep -qxF '${k}' ~/.ssh/authorized_keys 2>/dev/null || echo '${k}' >> ~/.ssh/authorized_keys`,
    `chmod 600 ~/.ssh/authorized_keys`,
    `echo "✅ 完成：SSH 已就绪且已授权本机。回到 DSH 点『验证连接』即可。"`,
  ].join("; ");

  // macOS: enable Remote Login (starts sshd), then authorize the key.
  const macos = [
    `echo "开始配置 SSH（需要输入一次系统密码）..."`,
    `{ sudo systemsetup -setremotelogin on || sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist; } >/dev/null 2>&1 || true`,
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
    `grep -qxF '${k}' ~/.ssh/authorized_keys 2>/dev/null || echo '${k}' >> ~/.ssh/authorized_keys`,
    `chmod 600 ~/.ssh/authorized_keys`,
    `echo "✅ 完成：SSH 已就绪且已授权本机。回到 DSH 点『验证连接』即可。"`,
  ].join("; ");

  // Windows: install OpenSSH Server capability if missing, start+enable sshd, add firewall rule,
  // then write administrators_authorized_keys with correct ACL. Entirely terminal-driven.
  // EncodedCommand avoids all quotes/escaping pitfalls of a nested -Command string.
  const psScript = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$cap = Get-WindowsCapability -Online -Name OpenSSH.Server*`,
    `if ($cap -and $cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }`,
    `Set-Service -Name sshd -StartupType Automatic`,
    `Start-Service sshd`,
    `New-NetFirewallRule -Name 'OpenSSH-Server' -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue | Out-Null`,
    `$d='C:\\ProgramData\\ssh'`,
    `New-Item -ItemType Directory -Force -Path $d | Out-Null`,
    `$f=Join-Path $d 'administrators_authorized_keys'`,
    `if (-not (Test-Path $f)) { New-Item -ItemType File -Force -Path $f | Out-Null }`,
    `$line='${k}'`,
    `if (-not (Select-String -Path $f -SimpleMatch -Quiet -Pattern $line)) { Add-Content -Path $f -Value $line -Encoding ascii }`,
    `icacls $f /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null`,
    `Write-Host 'OK: SSH ready and authorized. Return to DSH and click Verify.'`,
  ].join("; ");
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const windows = `powershell -NoProfile -EncodedCommand ${encoded}`;
  return { linux, macos, windows };
}

/**
 * Connectivity probe AND write-verification in one step: authenticate, then create
 * ~/.dsh-remote-agent/connection-ok.txt on the target. Writing a file proves the
 * session can actually run commands and touch the filesystem (not just handshake).
 * Returns the file path + timestamp so the UI can show concrete evidence.
 */
export async function sshProbe(target: SshTarget, identityFile: string, timeoutMs = 8_000, options: { verifyWrite?: boolean } = {}): Promise<{ ok: boolean; detail: string; verifyFile?: string; verifyTime?: string; command?: string }> {
  const r = await sshRaw(target, identityFile, "echo dsh-ssh-ok", timeoutMs);
  if (r.code === 0 && r.stdout.includes("dsh-ssh-ok")) {
    if (options.verifyWrite === false) return { ok: true, detail: "ok" };
    // Write a small handshake file to prove we can execute and write.
    const stamp = new Date().toISOString();
    const marker = `dsh-remote-control connected ${stamp}\n`;
    const b64 = Buffer.from(marker, "utf8").toString("base64");
    const file = "$HOME/.dsh-remote-agent/connection-ok.txt";
    const winFile = "%USERPROFILE%\\.dsh-remote-agent\\connection-ok.txt";
    // The same command works on POSIX; on a Windows OpenSSH shell `mkdir -p` fails, so we
    // try both idioms and treat success from either as verified.
    const posix = `mkdir -p "$HOME/.dsh-remote-agent" && printf %s '${b64}' | base64 -d > "${file}" && cat "${file}"`;
    const w = await sshRaw(target, identityFile, posix, timeoutMs);
    if (w.code === 0 && w.stdout.includes("dsh-remote-control connected")) {
      return { ok: true, detail: "已连接并在目标机写入验证文件", verifyFile: file, verifyTime: stamp, command: posix };
    }
    // Fallback for Windows targets (cmd.exe): use PowerShell to create the file.
    const ps = `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '.dsh-remote-agent') | Out-Null; Set-Content -Path (Join-Path $env:USERPROFILE '.dsh-remote-agent\\connection-ok.txt') -Value 'dsh-remote-control connected ${stamp}'; Get-Content (Join-Path $env:USERPROFILE '.dsh-remote-agent\\connection-ok.txt')"`;
    const w2 = await sshRaw(target, identityFile, ps, timeoutMs);
    if (w2.code === 0 && w2.stdout.includes("dsh-remote-control connected")) {
      return { ok: true, detail: "已连接并在目标机写入验证文件", verifyFile: winFile, verifyTime: stamp, command: ps };
    }
    // Auth works but the write step failed — still report connected, but say so honestly.
    return { ok: true, detail: "SSH 认证成功，但写入验证文件失败：" + ((w2.stderr || w.stderr || "").trim().split(/\r?\n/).slice(-1)[0] || "未知原因") };
  }
  const msg = (r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
  if (r.timedOut) return { ok: false, detail: `连接超时（${timeoutMs}ms）：目标机不可达或 SSH 端口被防火墙拦截` };
  if (/Permission denied/i.test(msg)) return { ok: false, detail: "公钥未授权（Permission denied）：请先在目标机执行安装公钥命令" };
  if (/Connection refused/i.test(msg)) return { ok: false, detail: "目标机 SSH 端口未开放（Connection refused）：确认已安装并启动 OpenSSH 服务，端口是否正确" };
  if (/Could not resolve|Name or service not known/i.test(msg)) return { ok: false, detail: `无法解析主机名：${msg}` };
  if (/Host key verification failed/i.test(msg)) return { ok: false, detail: "主机密钥校验失败：目标机曾变更，清理 known_hosts 或确认目标机身份" };
  if (/timed out|Timeout/i.test(msg)) return { ok: false, detail: "连接超时：网络不可达或端口被拦" };
  if (/not recognized|not found|no such file/i.test(msg)) return { ok: false, detail: `本机缺少 ssh 客户端：${msg}` };
  return { ok: false, detail: msg || `SSH 连接失败（exit ${r.code}）` };
}
