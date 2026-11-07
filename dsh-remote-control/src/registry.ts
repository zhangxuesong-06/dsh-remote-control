/**
 * Machine registry: a small JSON file holding every remote machine the
 * controller (this DeepSeek Harness host) may talk to.
 *
 * Layout (default `~/.dsh-remote-control/machines.json`):
 * {
 *   "version": 1,
 *   "machines": [
 *     { "id": "office-pc", "name": "办公室主机", "host": "192.168.1.20",
 *       "port": 5188, "token": "dsh-rc-…", "enabled": true }
 *   ]
 * }
 *
 * The file is human-editable and is also managed by the remote_machine_add /
 * remote_machine_remove tools.
 */
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";

/** One connection path to a machine (direct, reverse tunnel or public tunnel). */
export interface RemotePath {
  kind: "direct" | "reverse" | "tunnel";
  host: string;
  port: number;
  /** Absolute base URL for public-tunnel paths, e.g. https://xxx.trycloudflare.com */
  url?: string;
}

/** One remote machine entry. */
export interface RemoteMachine {
  /** Stable id used as the `machine` argument of every tool. */
  id: string;
  /** Human-readable label. */
  name: string;
  /** IP or hostname of the machine running dsh-remote-agent. */
  host: string;
  /** Agent port (default 5188). */
  port: number;
  /** Shared secret; must match the agent's --token. */
  token: string;
  /** Optional SHA-256 of the token when the plaintext is not stored. */
  tokenSha256?: string;
  /** Disabled machines are skipped by remote_machine_list probes. */
  enabled: boolean;
  /** Remote workspace directory: relative exec/fs/upload/download paths resolve here. */
  workspace?: string;
  /** Remote OS platform, learned from /health (win32/linux/darwin). */
  platform?: "win32" | "linux" | "darwin" | string;
  /** Ordered connection paths; first live path wins (client falls back). */
  paths?: RemotePath[];
  /** Optional public tunnel base URL (Cloudflare / ngrok / frp), e.g. https://xxx.trycloudflare.com. */
  tunnelUrl?: string;
  /** Local proxy port assigned to the reverse tunnel, when active. */
  reversePort?: number;
  /** When the token was created (ms epoch); helps reconcile stale deploy commands. */
  tokenCreatedAt?: number;
  /** Saved from the settings panel: target login account (optional). */
  username?: string;
  /** Saved from the settings panel: target login password (plaintext, file mode 0600; never returned by API). */
  password?: string;
  /** Target OS hint saved from the panel (auto/windows/linux). */
  osHint?: "auto" | "windows" | "linux";
  /** Local workspace folder on this controller machine for this machine combo. */
  localWorkspace?: string;
  /** Probe on startup; this never deploys or executes commands. */
  autoConnect?: boolean;
  defaultCwd?: string;
  /** Ordinary defaults only: do not store credentials here. */
  defaultEnv?: Record<string, string>;
  lastSeenAt?: number;
  lastAgentVersion?: string;
  lastHostname?: string;
}

export interface MachineRegistry {
  version: 1;
  machines: RemoteMachine[];
  /** Execution mode chosen in the UI: 'local' (default) or 'remote'. */
  mode?: "local" | "remote";
  /** Machine the UI/composer indicator treats as current (only meaningful when mode === 'remote'). */
  activeMachineId?: string;
}

export const defaultRegistryPath = join(homedir(), ".dsh-remote-control", "machines.json");

function emptyRegistry(): MachineRegistry {
  return { version: 1, machines: [] };
}

/**
 * Normalize a public-tunnel address into an absolute base URL (no trailing slash).
 * Bare hosts are assumed to be HTTPS (Cloudflare/ngrok style). Returns undefined
 * for empty or non-http(s) values so a bad value never breaks loading.
 */
export function normalizeTunnelUrl(raw?: string): string | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    // Public endpoints must use TLS; HTTP remains available only on loopback for local proxies.
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** Normalize one raw machine record with tolerant defaults. */
export function normalizeMachine(raw: unknown): RemoteMachine | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const host = typeof record.host === "string" ? record.host.trim() : "";
  if (!id || !host) return null;
  const port = typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0 && record.port < 65536
    ? record.port
    : 5188;
  const paths = Array.isArray(record.paths)
    ? record.paths
      .filter((p): p is RemotePath =>
        !!p && typeof p === "object" &&
        (p.kind === "direct" || p.kind === "reverse" || p.kind === "tunnel") &&
        typeof p.host === "string" && !!p.host &&
        typeof p.port === "number" && Number.isInteger(p.port) && p.port > 0 && p.port < 65536)
    : undefined;
  return {
    id,
    name: typeof record.name === "string" && record.name ? record.name : id,
    host,
    port,
    token: typeof record.token === "string" ? record.token : "",
    tokenSha256: typeof record.tokenSha256 === "string" && record.tokenSha256 ? record.tokenSha256 : undefined,
    enabled: record.enabled !== false,
    workspace: typeof record.workspace === "string" && record.workspace ? record.workspace : undefined,
    platform: typeof record.platform === "string" && record.platform ? record.platform : undefined,
    paths: paths && paths.length > 0 ? paths : undefined,
    tunnelUrl: normalizeTunnelUrl(typeof record.tunnelUrl === "string" ? record.tunnelUrl : undefined),
    reversePort: typeof record.reversePort === "number" && Number.isInteger(record.reversePort) ? record.reversePort : undefined,
    tokenCreatedAt: typeof record.tokenCreatedAt === "number" ? record.tokenCreatedAt : undefined,
    username: typeof record.username === "string" && record.username ? record.username : undefined,
    password: typeof record.password === "string" && record.password ? record.password : undefined,
    osHint: record.osHint === "windows" || record.osHint === "linux" || record.osHint === "auto" ? record.osHint : undefined,
    localWorkspace: typeof record.localWorkspace === "string" && record.localWorkspace ? record.localWorkspace : undefined,
    autoConnect: record.autoConnect === true,
    defaultCwd: typeof record.defaultCwd === "string" && record.defaultCwd ? record.defaultCwd : undefined,
    defaultEnv: record.defaultEnv && typeof record.defaultEnv === "object" && !Array.isArray(record.defaultEnv)
      ? Object.fromEntries(Object.entries(record.defaultEnv).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string")) as Record<string, string>
      : undefined,
    lastSeenAt: typeof record.lastSeenAt === "number" ? record.lastSeenAt : undefined,
    lastAgentVersion: typeof record.lastAgentVersion === "string" ? record.lastAgentVersion : undefined,
    lastHostname: typeof record.lastHostname === "string" ? record.lastHostname : undefined,
  };
}

/**
 * Load the registry. Malformed files never crash the plugin: a parse error
 * yields an empty registry (the error is reported through the thrown-away
 * diagnostics path by the caller).
 */
export function loadRegistry(file: string = defaultRegistryPath): MachineRegistry {
  if (!existsSync(file)) return emptyRegistry();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("登记表不是 JSON 对象");
    const list = (parsed as Record<string, unknown>).machines;
    if (!Array.isArray(list)) throw new Error("登记表缺少 machines 数组");
    const machines = list.map(normalizeMachine).filter((m): m is RemoteMachine => m !== null);
    const rawActive = (parsed as Record<string, unknown>).activeMachineId;
    const activeMachineId = typeof rawActive === "string" && machines.some((m) => m.id === rawActive)
      ? rawActive
      : undefined;
    // Derive mode: explicit value wins; otherwise infer from activeMachineId for old files.
    const rawMode = (parsed as Record<string, unknown>).mode;
    const mode = rawMode === "local" || rawMode === "remote"
      ? rawMode
      : activeMachineId ? "remote" : "local";
    return { version: 1, machines, mode, ...(activeMachineId ? { activeMachineId } : {}) };
  } catch (error) {
    throw new Error(`无法读取机器登记表，已拒绝覆盖现有数据：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Atomically save the registry (tmp file + rename) and restrict permissions. */
export function saveRegistry(file: string = defaultRegistryPath, registry: MachineRegistry): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    // Best-effort on POSIX; ignored on Windows.
    chmodSync(file, 0o600);
  } catch {
    // Windows / EPERM: leave default ACLs.
  }
}

/** Resolve the effective registry path from config.
 *  Default order: configured path → DSH_HOME/dsh-remote-control/machines.json
 *  (keeps all plugin data inside the harness data dir) → ~/.dsh-remote-control. */
export function resolveRegistryPath(configured: string): string {
  if (configured && configured.trim()) return configured.trim();
  const dshHome = process.env.DSH_HOME?.trim();
  if (dshHome) return join(dshHome, "dsh-remote-control", "machines.json");
  return defaultRegistryPath;
}
