/**
 * Managed `cloudflared access tcp` forwarders.
 *
 * Cloudflare named tunnels expose SSH over a public hostname, but the controller
 * side must run `cloudflared access tcp --hostname H --url 127.0.0.1:P` to turn
 * that hostname into a local TCP port. Requiring the user to keep a separate
 * terminal open defeats the point, so the plugin owns those child processes:
 * it downloads cloudflared if needed, picks a free local port, waits until the
 * port actually accepts connections, and restarts with backoff after a crash.
 *
 * Everything stays in-process; nothing outside the plugin has to be managed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";

export interface ForwarderState {
  /** Cloudflare hostname being forwarded (e.g. ssh.example.com). */
  hostname: string;
  /** Local port the forwarder listens on. */
  localPort: number;
  running: boolean;
  startedAt?: number;
  restarts: number;
  error?: string;
  log: string[];
}

/** Ask the OS for a free TCP port on the loopback interface. */
export function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("无法分配本地端口"))));
    });
  });
}

/** True when something accepts TCP connections on host:port (the forwarder is ready). */
export function canConnect(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export class TunnelForwarder {
  state: ForwarderState;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private binPath: string,
    hostname: string,
    private localPort: number,
    private readyTimeoutMs = 45_000,
  ) {
    this.state = { hostname, localPort, running: false, restarts: 0, log: [] };
  }

  /** Start and resolve once the local port accepts connections (or fail with a reason). */
  async start(): Promise<ForwarderState> {
    this.stopping = false;
    this.clearTimer();
    this.state.error = undefined;
    this.state.log = [];

    const args = ["access", "tcp", "--hostname", this.state.hostname, "--url", `127.0.0.1:${this.state.localPort}`];
    const child = spawn(this.binPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    const capture = (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        this.state.log.push(t);
        if (this.state.log.length > 120) this.state.log.shift();
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", (e) => { this.state.error = e.message; });

    const ready = await this.waitReady();
    if (ready) {
      // A listening port only proves the helper started. Probe through it: a valid tunnel keeps
      // the connection open (SSH banner pending), while a wrong/unreachable hostname resets it.
      const live = await this.probeThrough();
      if (live.ok) {
        this.state.running = true;
        this.state.startedAt = Date.now();
        child.once("exit", (code) => this.onExit(code));
        return this.state;
      }
      this.state.error = live.error;
    } else {
      this.state.error = this.state.error
        || `等待本地端口 ${this.state.localPort} 就绪超时：cloudflared 未能启动。`;
    }

    this.state.running = false;
    this.kill();
    return this.state;
  }

  /**
   * Open a TCP connection through the forwarder. If cloudflared cannot reach the configured
   * hostname it closes immediately, and its log names the reason, which we surface verbatim.
   */
  private probeThrough(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        sock.removeAllListeners();
        sock.destroy();
        resolve(r);
      };
      const sock = connect({ host: "127.0.0.1", port: this.state.localPort });
      sock.setTimeout(4_000, () => done({ ok: true })); // stayed open → tunnel is up
      sock.once("connect", () => { /* wait for banner or reset */ });
      sock.once("error", () => done({ ok: false, error: this.failureReason() }));
      sock.once("close", () => done({ ok: false, error: this.failureReason() }));
    });
  }

  /** Best available reason from cloudflared's own log lines. */
  private failureReason(): string {
    const line = [...this.state.log].reverse().find((l) => /failed to connect|no such host|connection refused|timeout|unauthorized|not found/i.test(l));
    if (!line) return `转发已启动但目标域名不可达（127.0.0.1:${this.state.localPort} 连接被关闭）。`;
    const m = /error="([^"]+)"/.exec(line);
    return `无法连接到 ${this.state.hostname}：${m ? m[1] : line.slice(0, 200)}`;
  }

  private async waitReady(): Promise<boolean> {
    const deadline = Date.now() + this.readyTimeoutMs;
    // cloudflared access listens almost immediately even before the tunnel is reachable;
    // a TCP accept therefore only proves the helper started, so also require it to stay up.
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) return false;
      if (await canConnect("127.0.0.1", this.state.localPort)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /** Restart after an unexpected exit, with a simple linear backoff cap. */
  private onExit(code: number | null): void {
    this.state.running = false;
    this.child = null;
    if (this.stopping) return;
    this.state.restarts += 1;
    this.state.error = `cloudflared access 退出（code ${code}），正在重连…`;
    const delay = Math.min(2_000 * this.state.restarts, 15_000);
    this.timer = setTimeout(() => {
      if (this.stopping) return;
      void this.start();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private kill(): void {
    const c = this.child;
    this.child = null;
    if (!c) return;
    try {
      if (process.platform === "win32" && c.pid) {
        spawn("taskkill", ["/pid", String(c.pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
      } else {
        c.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }

  stop(): void {
    this.stopping = true;
    this.clearTimer();
    this.kill();
    this.state.running = false;
    this.state.error = undefined;
  }
}
