/**
 * Smoke test: boot a local dsh-remote-agent and exercise the compiled
 * RemoteClient (lib/agent-http.js) end to end.
 *   npm run smoke
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RemoteClient } from "../lib/agent-http.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(DIR, "..", "agent", "dsh-remote-agent.mjs");
const port = 39000 + Math.floor(Math.random() * 1000);
const token = `dsh-rc-test-${randomBytes(8).toString("hex")}`;
const work = await mkdtemp(path.join(os.tmpdir(), "dsh-remote-smoke-"));

const machine = { id: "smoke", name: "smoke", host: "127.0.0.1", port, token, enabled: true };
const client = new RemoteClient(machine, 15_000);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const child = spawn(process.execPath, [AGENT, "--port", String(port), "--token", token, "--name", "smoke-agent", "--workspace", path.join(work, "auto-ws")], {
  stdio: "ignore",
});

async function waitForAgent() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("agent exited early");
    try {
      await client.health(1_000);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("agent did not become healthy in time");
}

try {
  await waitForAgent();
  check("agent health", true, "agent started");

  const health = await client.health();
  check("health payload", health.version === "1.5.0" && health.name === "smoke-agent", `v${health.version} @${health.hostname}`);
  check("health workspace", health.workspace === path.join(work, "auto-ws"), `workspace reported: ${health.workspace}`);
  check("health catalog metadata", health.runningJobs === 0 && health.keepAwake === false, "idle and keep-awake disabled by default");

  const info = await client.sysinfo();
  check("sysinfo", info.platform === process.platform && info.memTotalBytes > 0, `${info.osType} ${info.arch}`);

  const exec = await client.exec("echo smoke-ok && echo err-line 1>&2", { timeoutMs: 10_000 });
  check("exec stdout", exec.exitCode === 0 && exec.stdout.includes("smoke-ok"), `exit=${exec.exitCode}`);
  check("exec stderr", exec.stderr.includes("err-line"), "stderr captured");
  check("exec command echo", exec.command === "echo smoke-ok && echo err-line 1>&2", "command field present");

  const fail = await client.exec("exit 7", { timeoutMs: 10_000 });
  check("exec exit code", fail.exitCode === 7, `exit=${fail.exitCode}`);

  const remoteDir = path.join(work, "remote");
  const fsWrite = await client.fs("write", { path: path.join(remoteDir, "a.txt"), content: "你好 remote" });
  check("fs write", fsWrite && fsWrite.sizeBytes === Buffer.byteLength("你好 remote"), "utf8 bytes");

  const fsRead = await client.fs("read", { path: path.join(remoteDir, "a.txt") });
  check("fs read", fsRead && fsRead.content === "你好 remote", JSON.stringify(fsRead.content));

  const fsList = await client.fs("list", { path: remoteDir });
  check("fs list", Array.isArray(fsList) && fsList.length === 1 && fsList[0].name === "a.txt", "entry listed");

  const uploadLocal = path.join(work, "up.bin");
  await writeFile(uploadLocal, Buffer.from([0, 1, 2, 3, 250, 251]));
  const up = await client.upload(uploadLocal, path.join(remoteDir, "up.bin"), { timeoutMs: 20_000 });
  check("upload", up && up.sizeBytes === 6, "binary roundtrip");

  const downloadLocal = path.join(work, "down.bin");
  const down = await client.download(path.join(remoteDir, "up.bin"), downloadLocal, { timeoutMs: 20_000 });
  const buf = await readFile(downloadLocal);
  check("download", down.sizeBytes === 6 && buf.equals(Buffer.from([0, 1, 2, 3, 250, 251])), "bytes equal");

  const procs = await client.processes();
  check("processes", Array.isArray(procs) && procs.some((p) => p.pid === process.pid || p.pid === child.pid), `${procs.length} processes listed`);

  // 后台任务：立即返回、可轮询、可结束。
  const slow = process.platform === "win32"
    ? "echo job-start && ping -n 3 127.0.0.1 >nul && echo job-done && exit 0"
    : "echo job-start; sleep 1; echo job-done; exit 0";
  const job = await client.startJob(slow, { timeoutMs: 20_000 });
  check("job start", typeof job.id === "string" && job.running === true, `${job.id} running`);

  let output = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    output = await client.jobOutput(job.id);
    if (!output.running) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("job output", output && output.stdout.includes("job-start") && output.stdout.includes("job-done"), `exit=${output?.exitCode}`);
  check("job exit code", output && output.exitCode === 0 && output.timedOut === false, JSON.stringify({ exit: output?.exitCode, timedOut: output?.timedOut }));

  const listedJobs = await client.listJobs();
  check("job list", Array.isArray(listedJobs) && listedJobs.some((item) => item.id === job.id), `${listedJobs.length} jobs`);

  const longJob = await client.startJob(process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30", {});
  const killed = await client.killJob(longJob.id);
  check("job kill", killed.killed === true, killed.message);
  let killedState = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    killedState = await client.jobOutput(longJob.id);
    if (!killedState.running) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("job kill settles", killedState && killedState.running === false, `exit=${killedState?.exitCode}`);

  const auth = await fetch(`http://127.0.0.1:${port}/health`);
  check("auth reject", auth.status === 401, `HTTP ${auth.status} without token`);

  // --token-sha256 模式：控制端只存哈希即可认证。
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const port2 = port + 1000;
  const child2 = spawn(process.execPath, [AGENT, "--port", String(port2), "--token-sha256", tokenHash, "--name", "smoke-hash"], {
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  let hashOk = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/health`, {
        headers: { "X-DSH-Token": tokenHash },
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) {
        hashOk = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  check("token-sha256 auth", hashOk, "hash-only credential accepted");
  const noAuth = await fetch(`http://127.0.0.1:${port2}/health`);
  check("token-sha256 reject", noAuth.status === 401, "rejected without hash");
  child2.kill();
} catch (error) {
  check("unexpected error", false, error.message);
} finally {
  child.kill();
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
