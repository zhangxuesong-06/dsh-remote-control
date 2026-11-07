/**
 * Reverse-connect gateway (controller side).
 *
 * For networks where the controller cannot reach the target, but the target
 * can reach the controller (the archive's real-world failure mode), the agent
 * connects BACK to this gateway and we expose its HTTP API through a local
 * proxy port. Tools then talk to 127.0.0.1:<proxyPort> as a normal path.
 *
 * Wire protocol (authenticated):
 *   agent  -> gateway:  "DSH-REV1 <token> <agentHttpPort>\n"
 *   agent  -> gateway:  "DSH-FETCH <token>\n"  → gateway streams the raw agent
 *                       script and closes (short paste bootstrap).
 *   gateway-> agent  :  nothing, until an HTTP client arrives on the proxy
 *   gateway-> agent  :  single byte 0x01 = "you are now paired", followed by
 *                       the raw client byte stream; agent pumps it to its own
 *                       127.0.0.1:agentHttpPort and pumps responses back.
 *
 * The token is validated against the machine registry before any pairing or
 * fetch, so unlike the archive's manual tunnel, anonymous sockets are never
 * proxied and never receive the agent payload.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import type { RemoteMachine, RemotePath } from "./registry.js";

export interface ReverseSessionStatus {
  machineId: string;
  agentPort: number;
  proxyPort: number;
  idleCount: number;
  busyCount: number;
  lastSeen: number;
  connected: boolean;
}

export interface ReverseGatewayOptions {
  listenHost: string;
  listenPort: number;
  proxyStart: number;
  proxyCount: number;
  /** 空闲隧道 PING 间隔（默认 30s；测试可调小）。 */
  heartbeatIntervalMs?: number;
  /** 超过该时长未收到 PONG 判定死链（默认 75s）。 */
  staleIdleMs?: number;
  /** 短命令引导时按需下发的 agent 脚本路径。 */
  agentFilePath: string;
  /** Resolve the machine entry owning a handshake token (plaintext or sha256). */
  findMachineByToken: (token: string) => RemoteMachine | undefined;
  /** Persist the reverse path + assigned proxy port for a machine. */
  onPathsUpdate: (machineId: string, paths: RemotePath[], reversePort: number) => void;
  log: (message: string) => void;
}

interface Session {
  machineId: string;
  tokenHash: string;
  agentPort: number;
  proxyPort: number;
  directHost: string;
  directPort: number;
  idle: net.Socket[];
  busy: Set<net.Socket>;
  lastSeen: number;
}

const GO = Buffer.from([0x01]);
const PING = Buffer.from([0x00]);
const MAX_HANDSHAKE_BYTES = 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_IDLE_MS = 75_000;

export class ReverseGateway {
  private readonly opts: ReverseGatewayOptions;
  private server: net.Server | null = null;
  private readonly proxies = new Map<number, net.Server>();
  private readonly proxyToSession = new Map<number, Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<number, Array<{ socket: net.Socket; timer: NodeJS.Timeout }>>();
  private readonly proxyClients = new Map<number, Set<net.Socket>>();
  private readonly idleListeners = new WeakMap<net.Socket, (chunk: Buffer) => void>();
  private readonly lastPong = new WeakMap<net.Socket, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private nextProxyPort = 0;

  constructor(opts: ReverseGatewayOptions) {
    this.opts = opts;
    this.nextProxyPort = opts.proxyStart;
  }

  actualListenPort(): number {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : this.opts.listenPort;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  /** Bind the reverse listener (idempotent; EADDRINUSE 时自动顺延最多 20 个端口)。 */
  async start(): Promise<number> {
    if (this.server) return this.actualListenPort();
    let lastError: unknown = null;
    for (let offset = 0; offset <= 20; offset++) {
      const port = this.opts.listenPort + offset;
      try {
        await new Promise<void>((resolve, reject) => {
          const server = net.createServer((socket) => this.handleReverseConn(socket));
          server.once("error", reject);
          server.listen(port, this.opts.listenHost, () => {
            server.removeListener("error", reject);
            server.on("error", (error) => this.opts.log(`[reverse] 监听错误: ${String(error)}`));
            resolve();
          });
          this.server = server;
        });
        if (!this.heartbeat) {
          this.heartbeat = setInterval(
            () => this.heartbeatTick(),
            this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
          );
          this.heartbeat.unref();
        }
        const actual = this.actualListenPort();
        if (offset > 0) {
          this.opts.log(`[reverse] 端口 ${this.opts.listenPort} 被占用，已顺延到 ${actual}`);
        }
        this.opts.log(`[reverse] 反向接入网关已启动: ${this.opts.listenHost}:${actual}（token 认证 + 30s 心跳保活）`);
        return actual;
      } catch (error) {
        this.server = null;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "EADDRINUSE") throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`端口 ${this.opts.listenPort}~${this.opts.listenPort + 20} 均被占用`);
  }

  /** Ensure a local proxy port exists for one machine (idempotent). */
  async ensureProxy(machine: RemoteMachine, agentPort: number): Promise<number> {
    const tokenHash = hashToken(machine.token || machine.tokenSha256 || "");
    let session = this.sessions.get(tokenHash);
    if (!session) {
      const proxyPort = machine.reversePort && machine.reversePort >= this.opts.proxyStart
        && machine.reversePort < this.opts.proxyStart + this.opts.proxyCount
        ? machine.reversePort
        : this.assignProxyPort();
      session = {
        machineId: machine.id,
        tokenHash,
        agentPort,
        proxyPort,
        directHost: machine.host,
        directPort: agentPort,
        idle: [],
        busy: new Set(),
        lastSeen: 0,
      };
      this.sessions.set(tokenHash, session);
      this.opts.onPathsUpdate(machine.id, [
        { kind: "reverse", host: "127.0.0.1", port: proxyPort },
        { kind: "direct", host: machine.host, port: agentPort },
      ], proxyPort);
    } else {
      session.agentPort = agentPort;
      if (session.machineId !== machine.id) {
        session.machineId = machine.id;
        this.opts.onPathsUpdate(machine.id, [
          { kind: "reverse", host: "127.0.0.1", port: session.proxyPort },
          { kind: "direct", host: machine.host, port: agentPort },
        ], session.proxyPort);
      }
    }
    await this.ensureProxyServer(session);
    return session.proxyPort;
  }

  status(): ReverseSessionStatus[] {
    return [...this.sessions.values()].map((s) => ({
      machineId: s.machineId,
      agentPort: s.agentPort,
      proxyPort: s.proxyPort,
      idleCount: s.idle.length,
      busyCount: s.busy.size,
      lastSeen: s.lastSeen,
      connected: s.idle.length + s.busy.size > 0,
    }));
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // 1) 断开所有排队/已配对的代理客户端，让 proxy close 能落地。
    for (const [port, queue] of this.queues) {
      for (const item of queue) {
        clearTimeout(item.timer);
        item.socket.destroy();
      }
      this.queues.delete(port);
    }
    for (const clients of this.proxyClients.values()) {
      for (const client of clients) client.destroy();
    }
    // 2) 断开所有反向隧道。
    for (const session of this.sessions.values()) {
      for (const socket of [...session.idle, ...session.busy]) socket.destroy();
    }
    this.sessions.clear();
    // 3) 关代理端口。
    for (const server of this.proxies.values()) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.proxies.clear();
    this.proxyToSession.clear();
    this.proxyClients.clear();
    // 4) 关反向接入主监听。
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────
  private assignProxyPort(): number {
    const port = this.nextProxyPort;
    this.nextProxyPort += 1;
    if (this.nextProxyPort >= this.opts.proxyStart + this.opts.proxyCount) {
      this.nextProxyPort = this.opts.proxyStart;
    }
    return port;
  }

  private handleReverseConn(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(10_000, () => {
      socket.write("ERR TIMEOUT\n");
      socket.end();
    });

    const fail = (message: string) => {
      socket.write(`ERR ${message}\n`);
      socket.end();
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        fail("HANDSHAKE_TOO_LARGE");
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      socket.removeAllListeners("data");
      buffer = Buffer.alloc(0);
      this.finishHandshake(socket, line);
    });
    socket.on("error", () => socket.destroy());
  }

  private finishHandshake(socket: net.Socket, line: string): void {
    // 短命令引导：认证后直接下发 agent 脚本原始字节并关闭连接。
    if (line.startsWith("DSH-FETCH ")) {
      const token = line.slice("DSH-FETCH ".length).trim();
      const machine = this.opts.findMachineByToken(token);
      if (!machine) {
        socket.write("ERR AUTH\n");
        socket.end();
        return;
      }
      try {
        socket.end(readFileSync(this.opts.agentFilePath));
        this.opts.log(`[reverse] 机器 ${machine.id} 通过 DSH-FETCH 拉取 agent 脚本`);
      } catch (error) {
        socket.write(`ERR NOFILE ${error instanceof Error ? error.message : String(error)}\n`);
        socket.end();
      }
      return;
    }

    const parts = line.split(/\s+/);
    if (parts.length !== 3 || parts[0] !== "DSH-REV1") {
      socket.write("ERR BAD_HANDSHAKE\n");
      socket.end();
      return;
    }
    const token = parts[1];
    const agentPort = Number(parts[2]);
    if (!Number.isInteger(agentPort) || agentPort < 1 || agentPort > 65535) {
      socket.write("ERR BAD_PORT\n");
      socket.end();
      return;
    }
    const machine = this.opts.findMachineByToken(token);
    if (!machine) {
      socket.write("ERR AUTH\n");
      socket.end();
      return;
    }

    const tokenHash = hashToken(machine.token || machine.tokenSha256 || "");
    let session = this.sessions.get(tokenHash);
    if (!session) {
      const proxyPort = machine.reversePort ?? this.assignProxyPort();
      session = {
        machineId: machine.id,
        tokenHash,
        agentPort,
        proxyPort,
        directHost: machine.host,
        directPort: machine.port,
        idle: [],
        busy: new Set(),
        lastSeen: 0,
      };
      this.sessions.set(tokenHash, session);
      this.opts.onPathsUpdate(machine.id, [
        { kind: "reverse", host: "127.0.0.1", port: proxyPort },
        { kind: "direct", host: machine.host, port: machine.port },
      ], proxyPort);
      void this.ensureProxyServer(session).catch((error) => this.opts.log(`[reverse] 代理端口启动失败: ${String(error)}`));
    } else {
      session.agentPort = agentPort;
      session.directHost = machine.host;
      session.directPort = machine.port;
    }

    socket.setTimeout(0);
    session.lastSeen = Date.now();
    this.lastPong.set(socket, Date.now());
    // 空闲期监听 PONG（0x00）；配对前会移除，避免吃掉 HTTP 响应字节。
    const onIdleData = (_chunk: Buffer) => {
      this.lastPong.set(socket, Date.now());
    };
    this.idleListeners.set(socket, onIdleData);
    socket.on("data", onIdleData);
    session.idle.push(socket);
    this.drainQueue(session);
    const remove = () => {
      const i = session.idle.indexOf(socket);
      if (i >= 0) session.idle.splice(i, 1);
      session.busy.delete(socket);
      session.lastSeen = Date.now();
    };
    socket.on("close", remove);
    socket.on("error", () => socket.destroy());
  }

  private async ensureProxyServer(session: Session): Promise<void> {
    if (this.proxies.has(session.proxyPort)) return;
    const max = this.opts.proxyStart + this.opts.proxyCount;
    let lastError: unknown = null;
    for (let port = session.proxyPort; port < max; port++) {
      if (this.proxies.has(port)) continue;
      const server = net.createServer((client) => this.handleProxyClient(session, client));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", reject);
            server.on("error", (error) => this.opts.log(`[reverse] 代理 ${port} 错误: ${String(error)}`));
            resolve();
          });
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "EADDRINUSE") throw error;
        lastError = error;
        continue;
      }
      session.proxyPort = port;
      this.proxies.set(port, server);
      this.proxyToSession.set(port, session);
      this.proxyClients.set(port, new Set());
      this.opts.log(`[reverse] 机器 ${session.machineId} 本地代理已就绪: 127.0.0.1:${port}`);
      this.opts.onPathsUpdate(session.machineId, [
        { kind: "reverse", host: "127.0.0.1", port },
        { kind: "direct", host: session.directHost, port: session.directPort },
      ], port);
      return;
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`代理端口段 ${this.opts.proxyStart}~${max - 1} 已用尽`);
  }

  private handleProxyClient(session: Session, client: net.Socket): void {
    let clients = this.proxyClients.get(session.proxyPort);
    if (!clients) {
      clients = new Set();
      this.proxyClients.set(session.proxyPort, clients);
    }
    clients.add(client);
    client.on("close", () => {
      clients.delete(client);
    });
    const tunnel = session.idle.shift();
    if (!tunnel) {
      const timer = setTimeout(() => {
        client.destroy();
      }, 15_000);
      let queue = this.queues.get(session.proxyPort);
      if (!queue) {
        queue = [];
        this.queues.set(session.proxyPort, queue);
      }
      queue.push({ socket: client, timer });
      client.on("close", () => {
        clearTimeout(timer);
        const arr = this.queues.get(session.proxyPort) ?? [];
        const idx = arr.findIndex((item) => item.socket === client);
        if (idx >= 0) arr.splice(idx, 1);
      });
      return;
    }
    this.pair(session, client, tunnel);
  }

  private pair(session: Session, client: net.Socket, tunnel: net.Socket): void {
    const i = session.idle.indexOf(tunnel);
    if (i >= 0) session.idle.splice(i, 1);
    session.busy.add(tunnel);
    // 移除空闲期 PONG 监听，之后所有字节都属于 HTTP 数据流。
    const idleListener = this.idleListeners.get(tunnel);
    if (idleListener) tunnel.removeListener("data", idleListener);
    client.setNoDelay(true);
    tunnel.setNoDelay(true);
    tunnel.write(GO);
    client.pipe(tunnel);
    tunnel.pipe(client);
    const teardown = () => {
      client.destroy();
      tunnel.destroy();
      session.busy.delete(tunnel);
    };
    client.on("error", teardown);
    tunnel.on("error", teardown);
    client.on("close", teardown);
    tunnel.on("close", teardown);
  }

  /** 新隧道到达时，立即满足正在排队的代理客户端。 */
  private drainQueue(session: Session): void {
    const queue = this.queues.get(session.proxyPort);
    if (!queue || queue.length === 0) return;
    while (session.idle.length > 0 && queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      clearTimeout(item.timer);
      const tunnel = session.idle.shift();
      if (tunnel) this.pair(session, item.socket, tunnel);
    }
    if (queue.length === 0) this.queues.delete(session.proxyPort);
  }

  /** 周期 PING：空闲隧道无 PONG 超过阈值即判定死链，断开让 agent 自动重连。 */
  private heartbeatTick(): void {
    const now = Date.now();
    const staleMs = this.opts.staleIdleMs ?? STALE_IDLE_MS;
    for (const session of this.sessions.values()) {
      for (const socket of [...session.idle]) {
        const lastPong = this.lastPong.get(socket) ?? 0;
        if (now - lastPong > staleMs) {
          this.opts.log(
            `[reverse] 机器 ${session.machineId} 的空闲隧道无 PONG（${Math.round((now - lastPong) / 1000)}s, ${socket.remoteAddress}:${socket.remotePort}），断开等待重连`,
          );
          socket.destroy();
          continue;
        }
        socket.write(PING);
      }
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
