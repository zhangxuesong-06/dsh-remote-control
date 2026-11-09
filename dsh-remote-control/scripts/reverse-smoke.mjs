/**
 * Reverse-tunnel smoke test: plugin gateway + local agent with --reverse.
 * Verifies: connect_reverse tool flow, authenticated handshake, HTTP-through-
 * tunnel fs ops, heartbeat keeps idle tunnels alive, and path fallback.
 *
 * Run after tsc:  node scripts/reverse-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(DIR, "..", "agent", "dsh-remote-agent.mjs");
const work = await mkdtemp(path.join(os.tmpdir(), "dsh-rc-reverse-smoke-"));
const gatewayPort = 58000 + Math.floor(Math.random() * 400);
const proxyStart = 57000 + Math.floor(Math.random() * 100);
const agentPort = 45000 + Math.floor(Math.random() * 1000);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let agentChild = null;
const disposers = [];

try {
  const mod = await import("../lib/index.js");
  const tools = new Map();
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    tools: { register: (def) => tools.set(def.name, def) },
    logger: { info: (m) => console.log(`  [log] ${m}`) },
  };
  mod.apply(ctx, {
    registryFile: path.join(work, "machines.json"),
    defaultTimeoutMs: 10_000,
    healthProbeTimeoutMs: 2_000,
    reverseListenHost: "127.0.0.1",
    reverseListenPort: gatewayPort,
    reverseProxyStart: proxyStart,
    reverseProxyCount: 5,
  });

  const invoke = (name, args) => tools.get(name).execute(args, {});

  const out = await invoke("remote_connect_reverse", {
    id: "rev", host: "127.0.0.1", agent_port: agentPort, controller_host: "127.0.0.1",
  });
  check("connect_reverse flow", out.includes("反向接入已准备就绪") && out.includes("--reverse"), "tool output");

  const registry = JSON.parse(await readFile(path.join(work, "machines.json"), "utf8"));
  // Remote tools now require an explicitly selected target; mark this machine active.
  {
    const regFile = path.join(work, "machines.json");
    registry.mode = "remote"; registry.activeMachineId = "rev";
    await writeFile(regFile, JSON.stringify(registry, null, 2));
  }
  const machine = registry.machines[0];
  const token = machine.token;
  const reversePath = machine.paths.find((p) => p.kind === "reverse");
  check("registry paths", reversePath && machine.reversePort === reversePath.port, `proxy=${reversePath?.port}`);

  agentChild = spawn(process.execPath, [
    AGENT, "--port", String(agentPort), "--token", token,
    "--reverse", `127.0.0.1:${gatewayPort}`, "--reverse-pool", "2",
  ], { stdio: "ignore" });

  // 等反向隧道上线：通过 127.0.0.1:proxyPort 能拿到 agent /health。
  const deadline = Date.now() + 20_000;
  let health = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${reversePath.port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        health = await res.json();
        break;
      }
    } catch {
      // tunnel not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check("tunnel health", health?.data?.ok === true, `agent v${health?.data?.version}`);

  // 短命令取件协议：认证后经网关 DSH-FETCH 拉到完整 agent 脚本。
  const agentSource = await readFile(path.join(DIR, "..", "agent", "dsh-remote-agent.mjs"));
  const fetched = await new Promise((resolve, reject) => {
    const sock = net.connect(gatewayPort, "127.0.0.1");
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("DSH-FETCH timeout"));
    }, 10_000);
    sock.on("connect", () => sock.write(`DSH-FETCH ${token}\n`));
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    sock.on("error", reject);
  });
  check("gateway DSH-FETCH serves agent", fetched.equals(agentSource), `${fetched.length} bytes equal`);

  const badFetch = await new Promise((resolve, reject) => {
    const sock = net.connect(gatewayPort, "127.0.0.1");
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("bad fetch timeout"));
    }, 10_000);
    sock.on("connect", () => sock.write("DSH-FETCH wrong-token\n"));
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    sock.on("error", reject);
  });
  check("gateway DSH-FETCH auth", badFetch.startsWith("ERR AUTH"), "wrong token rejected");

  // 短命令生成：remote_deploy_command 带 controller_host 时优先给 DSH-FETCH 短命令。
  const deploy = await invoke("remote_deploy_command", { machine: "rev", os: "linux", controller_host: "127.0.0.1" });
  check("short linux command generated", deploy.includes("DSH-FETCH") && deploy.includes("/dev/tcp"), "short paste command present");

  // 空闲 3 秒（心跳短周期无法在测试中触发默认 30s，但可验证空闲连接未断）。
  await new Promise((r) => setTimeout(r, 3_000));
  const idleRes = await fetch(`http://127.0.0.1:${reversePath.port}/sysinfo`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2_000),
  });
  check("tunnel survives idle", idleRes.ok, "idle 3s then request ok");

  // 通过插件工具走隧道做文件操作。
  const remoteFile = path.join(work, "via-tunnel.txt");
  await invoke("remote_fs", { machine: "rev", operation: "write", path: remoteFile, content: "tunnel-ok" });
  const readBack = await invoke("remote_fs", { machine: "rev", operation: "read", path: remoteFile });
  check("fs over tunnel", readBack.includes("tunnel-ok"), "write+read through reverse proxy");

  const listed = await invoke("remote_machine_list", { probe: true });
  check("status shows reverse online", listed.includes("反向隧道") && listed.includes("在线"), "status line");

  // 路径回退：把直连路径换成死端口，验证请求自动回退到 reverse。
  const reg2 = JSON.parse(await readFile(path.join(work, "machines.json"), "utf8"));
  reg2.machines[0].paths = [
    { kind: "direct", host: "127.0.0.1", port: 39999 }, // 必死
    { kind: "reverse", host: "127.0.0.1", port: reversePath.port },
  ];
  await writeFile(path.join(work, "machines.json"), JSON.stringify(reg2, null, 2));
  const fallback = await invoke("remote_fs", { machine: "rev", operation: "read", path: remoteFile });
  check("path fallback direct→reverse", fallback.includes("tunnel-ok"), "dead direct path skipped");
} catch (error) {
  check("unexpected error", false, error?.message ?? String(error));
} finally {
  if (agentChild) agentChild.kill();
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch {
      // cleanup best effort
    }
  }
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
