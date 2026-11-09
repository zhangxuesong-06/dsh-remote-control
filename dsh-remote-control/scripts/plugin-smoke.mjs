/**
 * Plugin-layer smoke test: load the compiled plugin with a fake cordis ctx,
 * boot a local agent, and exercise remote_machine_add / remote_workspace /
 * workspace-relative fs + upload/download / remote_connect(linux).
 *
 * Run after tsc:  node scripts/plugin-smoke.mjs
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(DIR, "..", "agent", "dsh-remote-agent.mjs");
const port = 42000 + Math.floor(Math.random() * 500);
const token = `dsh-rc-plugintest-${randomBytes(8).toString("hex")}`;
const work = await mkdtemp(path.join(os.tmpdir(), "dsh-rc-plugin-smoke-"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const child = spawn(process.execPath, [AGENT, "--port", String(port), "--token", token, "--name", "plugin-smoke", "--workspace", path.join(work, "auto-ws")], {
  stdio: "ignore",
});

async function waitAgent() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("agent exited early");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("agent did not become healthy");
}

let disposers = [];
try {
  await waitAgent();
  check("agent up", true);

  const mod = await import("../lib/index.js");
  const tools = new Map();
  const webRoutes = [];
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(def) {
        tools.set(def.name, def);
      },
    },
    webServer: {
      register(spec) {
        webRoutes.push(spec);
        return () => {};
      },
    },
    logger: { info: () => {} },
  };
  mod.apply(ctx, {
    registryFile: path.join(work, "machines.json"),
    defaultTimeoutMs: 15_000,
    healthProbeTimeoutMs: 3_000,
    reverseListenHost: "127.0.0.1",
    reverseListenPort: 0,
    reverseProxyStart: 55_000,
    reverseProxyCount: 5,
  });

  const expected = [
    "remote_connect", "remote_connect_reverse", "remote_deploy_command", "remote_diagnose",
    "remote_machine_list", "remote_machine_add", "remote_machine_remove",
    "remote_workspace", "remote_exec", "remote_fs", "remote_upload", "remote_download",
    "remote_sysinfo", "remote_processes", "remote_exec_bg", "remote_job", "remote_tunnel",
  ];
  check("tool registration", expected.every((n) => tools.has(n)), `${tools.size} tools`);

  const invoke = (name, args) => tools.get(name).execute(args, {});
  const machine = "smoke";

  const added = await invoke("remote_machine_add", { id: machine, host: "127.0.0.1", port, token });
  check("machine add", added.includes("已登记"), "registered");
  // Remote tools now require an explicitly selected target; mark this machine active.
  {
    const regFile = path.join(work, "machines.json");
    const reg = JSON.parse(await readFile(regFile, "utf8"));
    reg.mode = "remote"; reg.activeMachineId = machine;
    await writeFile(regFile, JSON.stringify(reg, null, 2));
  }

  const listed = await invoke("remote_machine_list", { probe: true });
  check("machine list probe", listed.includes("在线") && listed.includes(machine), "online");
  const regAfterProbe = JSON.parse(await readFile(path.join(work, "machines.json"), "utf8"));
  const autoWs = path.join(work, "auto-ws");
  check("workspace auto-sync from agent", regAfterProbe.machines[0].workspace === autoWs, "synced from /health");

  const wsRoot = path.join(work, "ws");
  const created = await invoke("remote_workspace", { machine, operation: "create", path: wsRoot });
  check("workspace create", created.includes("已创建目录"), wsRoot);

  const set = await invoke("remote_workspace", { machine, operation: "set", path: wsRoot });
  check("workspace set", set.includes("远程工作区设为"), "workspace saved");

  await invoke("remote_fs", { machine, operation: "write", path: "a.txt", content: "你好 工作区" });
  const read = await invoke("remote_fs", { machine, operation: "read", path: "a.txt" });
  check("workspace-relative fs write/read", read.includes("你好 工作区"), "relative path resolved");

  const upLocal = path.join(work, "up.bin");
  await writeFile(upLocal, Buffer.from([9, 8, 7]));
  const up = await invoke("remote_upload", { machine, local_path: upLocal, remote_path: "up.bin" });
  check("workspace-relative upload", up.includes("已上传"), "uploaded");

  const downLocal = path.join(work, "down.bin");
  await invoke("remote_download", { machine, remote_path: "up.bin", local_path: downLocal });
  const buf = await readFile(downLocal);
  check("workspace-relative download", buf.equals(Buffer.from([9, 8, 7])), "bytes equal");

  // 后台长任务：启动 → 轮询 → 输出 → 列表。
  const bg = await invoke("remote_exec_bg", { machine, command: "echo bg-hello", timeout_ms: 20_000 });
  const jobId = /job-[a-z0-9-]+/.exec(bg)?.[0] ?? "";
  check("remote_exec_bg start", bg.includes("启动后台任务") && !!jobId, jobId);
  let jobOut = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    jobOut = await invoke("remote_job", { machine, action: "output", job_id: jobId });
    if (jobOut.includes("bg-hello")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("remote_job output", jobOut.includes("bg-hello"), "stdout captured");
  const jobList = await invoke("remote_job", { machine, action: "list" });
  check("remote_job list", jobList.includes(jobId), "job listed");

  // 公网隧道：本地 HTTP 反代等价于 cloudflared --url http://127.0.0.1:5188。
  const tunnelProxy = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => tunnelProxy.listen(0, "127.0.0.1", resolve));
  const tunnelUrl = `http://127.0.0.1:${tunnelProxy.address().port}`;

  const tunnelSet = await invoke("remote_tunnel", { machine, action: "set", url: tunnelUrl });
  check("remote_tunnel set", tunnelSet.includes("agent-ok") && tunnelSet.includes(tunnelUrl), "tunnel registered + probed");
  const viaTunnel = await invoke("remote_exec", { machine, command: "echo tunnel-ok" });
  check("remote_exec through tunnel", viaTunnel.includes("tunnel-ok"), "exec routed over tunnel");
  const listTunnel = await invoke("remote_machine_list", { probe: false });
  check("machine list shows tunnel", listTunnel.includes("公网隧道"), "tunnel path displayed");
  const cleared = await invoke("remote_tunnel", { machine, action: "clear" });
  check("remote_tunnel clear", cleared.includes("已清除"), "tunnel cleared");
  const afterClear = await invoke("remote_exec", { machine, command: "echo direct-again" });
  check("fallback to direct after clear", afterClear.includes("direct-again"), "direct path restored");
  await new Promise((resolve) => tunnelProxy.close(resolve));

  const listed2 = await invoke("remote_machine_list", { probe: false });
  check("workspace shown in list", listed2.includes(wsRoot), "displayed");

  const connect = await invoke("remote_connect", {
    id: "linux-test", host: "example.lan", username: "root", password: "secret", os: "linux",
  });
  check("remote_connect linux command", connect.includes("base64 -d") && connect.includes("gunzip") && connect.includes("```bash"), "gzip bootstrap command generated");
  check("remote_connect linux registered", connect.includes("已登记"), "machine reserved");

  // 幂等：再次调用复用 token，不更换。
  const connect2 = await invoke("remote_connect", {
    id: "linux-test", host: "example.lan", username: "root", password: "secret", os: "linux",
  });
  const registryAfter = JSON.parse(await readFile(path.join(work, "machines.json"), "utf8"));
  const linuxEntry = registryAfter.machines.find((m) => m.id === "linux-test");
  check("remote_connect token idempotent", linuxEntry.token && connect2.includes("复用已登记 token"), "token reused");

  // 一步连接：id 可选，按 host 自动生成。
  const connect3 = await invoke("remote_connect", {
    host: "example2.lan", username: "root", password: "secret", os: "linux",
  });
  const registryFinal = JSON.parse(await readFile(path.join(work, "machines.json"), "utf8"));
  check("remote_connect auto id", registryFinal.machines.some((m) => m.id === "pc-example2.lan"), "id derived from host");
  check("remote_connect workspace arg", connect3.includes("--workspace"), "command creates default workspace");

  const registry = registryFinal;
  check("registry persisted", registry.machines.length === 3, `${registry.machines.length} machines`);
  const comboMachines = registry.machines.filter((m) => m.id !== "smoke");
  check("combo credentials saved", comboMachines.length === 2 && comboMachines.every((m) => m.password === "secret" && m.username === "root"), "username/password stored in combo");
  // 「本机工作区」是已废弃字段：不再自动分配，也不应误导性地出现在登记表里。
  check("no misleading local workspace", registry.machines.every((m) => !m.localWorkspace), "local workspace removed");

  // 无密码 Windows 路径：短命令（DSH-FETCH）+ 长命令（内置 base64）都要有。
  const winCmd = await invoke("remote_deploy_command", { machine: "smoke", os: "windows" });
  check("windows deploy commands", winCmd.includes("DSH-FETCH") && winCmd.includes("FromBase64String") && winCmd.includes("schtasks") && winCmd.includes("```powershell"), "short + long PowerShell generated");

  // 设置页 API：列表必须脱敏（token/密码绝不返回）。
  const apiSpec = webRoutes.find((r) => r.path === "/dsh-remote-control/api");
  check("settings api route", !!apiSpec, "web route registered");
  if (apiSpec) {
    const apiRes = await new Promise((resolve) => {
      let body = "";
      const res = {
        writeHead: (code) => { res.status = code; },
        end: (chunk) => { body += chunk; resolve({ code: res.status, body }); },
      };
      apiSpec.handler({ url: "/dsh-remote-control/api/machines", method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1" } }, res);
    });
    const parsed = JSON.parse(apiRes.body);
    const leaked = parsed.machines.some((m) => "password" in m || "token" in m) || JSON.stringify(parsed.machines).includes("secret");
    check("api machines sanitized", parsed.ok && parsed.machines.length === 3 && !leaked, JSON.stringify(parsed).slice(0, 400));

    // 面板「一步连接」路径：参数必须满足 lossless JSON（历史回归点）。
    const connectRes = await new Promise((resolve) => {
      let body = "";
      const res = {
        writeHead: (code) => { res.status = code; },
        end: (chunk) => { body += chunk; resolve({ code: res.status, body }); },
      };
      apiSpec.handler({
        url: "/dsh-remote-control/api/connect",
        method: "POST",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1" },
        on: (event, cb) => {
          if (event === "data") cb(Buffer.from(JSON.stringify({ host: "127.0.0.1", username: "u", password: "", os: "linux" })));
          if (event === "end") cb();
        },
      }, res);
    });
    const connectParsed = JSON.parse(connectRes.body);
    check("panel connect lossless-json args", connectParsed.ok === true && String(connectParsed.result).includes("已登记"), String(connectParsed.result ?? connectParsed.error).slice(0, 120));
  }
} catch (error) {
  check("unexpected error", false, error.message);
} finally {
  child.kill();
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch {
      // best effort
    }
  }
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
