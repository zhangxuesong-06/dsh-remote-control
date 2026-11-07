/**
 * Heartbeat behavior test for the reverse gateway:
 *  - idle tunnels that answer PING (like our agent) stay alive across intervals
 *  - tunnels that never answer are declared stale and destroyed
 */
import net from "node:net";
import { ReverseGateway } from "../lib/reverse.js";

const token = "dsh-rc-heartbeat-test";
const machine = { id: "hb", name: "hb", host: "127.0.0.1", port: 5188, token, enabled: true };
const gw = new ReverseGateway({
  listenHost: "127.0.0.1",
  listenPort: 57700 + Math.floor(Math.random() * 50),
  proxyStart: 56650,
  proxyCount: 5,
  heartbeatIntervalMs: 300,
  staleIdleMs: 900,
  findMachineByToken: (t) => (t === token ? machine : undefined),
  onPathsUpdate: () => {},
  log: (m) => console.log("[gw]", m),
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await gw.start();

const alive = net.connect(gw.actualListenPort(), "127.0.0.1");
const dead = net.connect(gw.actualListenPort(), "127.0.0.1");
let deadClosed = false;

alive.on("connect", () => {
  console.log("alive connected", alive.localAddress, alive.localPort);
  alive.write(`DSH-REV1 ${token} 5188\n`);
});
alive.on("data", (chunk) => {
  // 模拟 agent 的空闲应答：任何字节都回 PONG 0x00。
  alive.write(Buffer.from([0x00]));
});
alive.on("close", () => console.log("alive closed"));
alive.on("error", () => {});

dead.on("connect", () => {
  console.log("dead connected", dead.localAddress, dead.localPort);
  dead.write(`DSH-REV1 ${token} 5188\n`);
});
// 读取但不回 PONG：保持流畅通，网关 FIN/RST 时能及时触发 close。
dead.on("data", () => {});
dead.on("close", () => {
  deadClosed = true;
  console.log("dead closed");
});
dead.on("error", () => {});

// 等两个隧道都进池。
const deadline = Date.now() + 5000;
while (Date.now() < deadline && (gw.status()[0]?.idleCount ?? 0) < 2) {
  await new Promise((r) => setTimeout(r, 100));
}
check("both tunnels registered", (gw.status()[0]?.idleCount ?? 0) >= 2, JSON.stringify(gw.status()));

// 3.5s：覆盖 11 个心跳周期；alive 应存活，dead 应被清除。
await new Promise((r) => setTimeout(r, 3500));
console.log("alive.destroyed=", alive.destroyed, "dead.destroyed=", dead.destroyed, "deadClosed=", deadClosed);
const status = gw.status()[0];
check("alive tunnel survives heartbeats", !alive.destroyed && (status?.connected ?? false), `idle=${status?.idleCount} busy=${status?.busyCount}`);
check("dead tunnel purged", deadClosed, "no-PONG socket destroyed");

alive.destroy();
await gw.stop();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
