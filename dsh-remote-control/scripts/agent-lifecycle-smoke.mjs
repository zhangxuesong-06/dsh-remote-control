// Confined tests: exercise production functions with deterministic process helpers.
// No OS power settings, real sleep inhibitors, or unconfined subprocesses are used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const source = fs.readFileSync(new URL("../agent/dsh-remote-agent.mjs", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const parseContext = vm.createContext({ process: { env: {}, exit() { throw Error("unexpected exit"); } }, os, console,
  fail(message) { throw Error(message); } });
vm.runInContext(section("function parseArgs(", "function fail(") + ";globalThis.parse = parseArgs;", parseContext);
test("keepawake defaults OFF; CLI flag opts in", () => {
  assert.equal(parseContext.parse([]).keepAwake, false);
  assert.equal(parseContext.parse(["--keep-awake"]).keepAwake, true);
});
test("max-exec-timeout CLI parsed and bounded", () => {
  assert.equal(parseContext.parse(["--max-exec-timeout", "321"]).maxExecTimeout, 321);
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "2147483648"]) {
    assert.throws(() => parseContext.parse(["--max-exec-timeout", value]));
  }
  assert.throws(() => parseContext.parse(["--max-exec-timeout", "--keep-awake"]));
});

function helperHarness(platform, requested = true) {
  const children = [], killed = [], timers = [];
  const context = vm.createContext({ opts: { keepAwake: requested }, process: { platform, pid: 1234, execPath: "node" },
    decodeOutput: (buffer) => buffer.toString(),
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      children.push({ command, args, options, child }); return child;
    },
    setTimeout(callback) { const timer = { callback, unref() {}, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    killTree(child) { killed.push(child); },
  });
  vm.runInContext(section("const keepAwakeStatus =", "// ── 后台作业") +
    ";globalThis.helper = { startKeepAwake, stopKeepAwake, status: keepAwakeStatus };", context);
  return { api: context.helper, children, killed, timers };
}
test("disabled keepawake never spawns a helper", () => {
  const h = helperHarness("win32", false); h.api.startKeepAwake();
  assert.equal(h.children.length, 0); assert.equal(h.api.status.state, "disabled");
});
for (const platform of ["win32", "darwin", "linux"]) {
  test(`${platform}: active only after READY, failure and cleanup tracked`, () => {
    const h = helperHarness(platform); h.api.startKeepAwake();
    assert.equal(h.api.status.state, "starting");
    const { child, command, args } = h.children[0];
    if (platform === "win32") {
      assert.equal(command, "powershell.exe");
      assert.ok(args.at(-1).includes("2147483649")); // SYSTEM_REQUIRED, no DISPLAY_REQUIRED.
      assert.ok(!args.at(-1).includes("2147483651"));
    } else if (platform === "darwin") assert.equal(args[0], "-i");
    else assert.ok(args.includes("--what=idle:sleep"));
    child.stdout.emit("data", Buffer.from("DSH_AWAKE_"));
    assert.equal(h.api.status.state, "starting");
    child.stdout.emit("data", Buffer.from("READY\n"));
    assert.equal(h.api.status.state, "active"); assert.equal(h.timers[0].cleared, true);
    child.emit("exit", 1, null);
    assert.equal(h.api.status.state, "failed"); assert.ok(h.api.status.error);
    const clean = helperHarness(platform); clean.api.startKeepAwake(); clean.api.stopKeepAwake();
    assert.equal(clean.api.status.state, "stopped"); assert.equal(clean.killed.length, 1);
    clean.children[0].child.emit("exit", 0, null);
    assert.equal(clean.api.status.state, "stopped");
  });
}
test("helper unavailable or startup timeout never claims active", () => {
  const h = helperHarness("linux"); h.api.startKeepAwake();
  h.children[0].child.emit("error", Error("ENOENT"));
  assert.equal(h.api.status.state, "failed"); assert.equal(h.killed.length, 1);
  const t = helperHarness("win32"); t.api.startKeepAwake(); t.timers[0].callback();
  assert.equal(t.api.status.state, "failed"); assert.equal(t.killed.length, 1);
  const u = helperHarness("unsupported"); u.api.startKeepAwake();
  assert.equal(u.api.status.state, "unavailable"); assert.equal(u.children.length, 0);
});

let spawned = 0;
const jobContext = vm.createContext({ HttpError, crypto, Buffer, MAX_OUTPUT: 1024, MAX_EXEC_TIMEOUT: 1000,
  process: { platform: "linux", env: {} }, resolveSpawnCwd: () => undefined,
  spawn() { spawned++; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; },
  killTree() {}, decodeOutput: (buffer) => buffer.toString(),
  setTimeout: () => ({ unref() {} }), clearTimeout() {},
});
vm.runInContext(section("const JOBS =", "// ── 各端点实现") +
  ";globalThis.jobs = { startJob, listJobs, finishJob, JOBS };", jobContext);
test("64 active jobs hard limit; 65th rejected before spawn with HTTP 429", () => {
  for (let i = 0; i < 64; i++) jobContext.jobs.startJob({ command: "long task" });
  assert.equal(jobContext.jobs.listJobs().length, 64);
  assert.throws(() => jobContext.jobs.startJob({ command: "extra" }), (error) => error.status === 429 && error.code === "JOB_LIMIT");
  assert.equal(spawned, 64); assert.equal(jobContext.jobs.JOBS.size, 64);
});
test("new job evicts completed entry without losing running work", () => {
  const oldest = jobContext.jobs.JOBS.values().next().value;
  jobContext.jobs.finishJob(oldest, 0, null, false);
  jobContext.jobs.startJob({ command: "replacement" });
  assert.equal(jobContext.jobs.JOBS.size, 64); assert.ok(!jobContext.jobs.JOBS.has(oldest.id));
});
test("health reports actual runningJobs and helper state", () => {
  vm.runInContext("globalThis.opts={workspace:'' , name:'test'};globalThis.VERSION='1.5.0';globalThis.os={hostname:()=>'',platform:()=>'',uptime:()=>1};globalThis.keepAwakeStatus={requested:true,state:'failed',error:'unavailable'};" +
    section("function health()", "async function fsOperation") + ";globalThis.getHealth = health;", jobContext);
  const health = jobContext.getHealth();
  assert.equal(health.runningJobs, 64); assert.equal(health.keepAwake, false);
  assert.equal(health.keepAwakeStatus.state, "failed");
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-lifecycle-"));
const root = path.join(temp, "root"), outside = path.join(temp, "outside");
fs.mkdirSync(root); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
const fileContext = vm.createContext({ fs, path, crypto, HttpError, Buffer, Transform, pipeline,
  opts: { root }, process: { pid: process.pid }, MAX_UPLOAD: 1024,
  ok(res, data) { res.result = { status: 200, data }; res.headersSent = true; },
  failResponse(res, status, code, message) { res.result = { status, code, message }; res.headersSent = true; },
});
vm.runInContext(section("function resolvePath(", "function guardDestructiveDelete") +
  section("async function handleUpload(", "async function handleDownload") +
  ";globalThis.fileApi = { resolvePath, handleUpload };", fileContext);
async function upload(chunks, target) {
  const req = Readable.from(chunks); req.aborted = false;
  const res = { destroyed: false, headersSent: false };
  await fileContext.fileApi.handleUpload(req, res, new URL(`http://localhost/upload?path=${encodeURIComponent(target)}`));
  return res.result;
}
try {
  test("root accepts inside absolute/new paths; rejects sibling traversal", () => {
    assert.equal(fileContext.fileApi.resolvePath(path.join(root, "new.txt")), path.join(root, "new.txt"));
    assert.throws(() => fileContext.fileApi.resolvePath(path.join(outside, "secret.txt")), (e) => e.code === "PATH_DENIED");
    assert.throws(() => fileContext.fileApi.resolvePath("../outside/new.txt"), (e) => e.code === "PATH_DENIED");
  });
  let linkSupported = true;
  try { fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir"); }
  catch (e) { linkSupported = false; console.log(`SKIP filesystem links unavailable: ${e.code}`); }
  if (linkSupported && !fs.lstatSync(path.join(root, "escape")).isSymbolicLink()) {
    linkSupported = false;
    console.log("SKIP sandbox converted requested junction to ordinary directory; testing link resolution with injected filesystem below");
  }
  if (linkSupported) test("existing symlink/junction and new child escape both refused", () => {
    for (const name of ["escape/secret.txt", "escape/new/deep.txt"]) {
      assert.throws(() => fileContext.fileApi.resolvePath(name), (e) => e.code === "PATH_DENIED", `name=${name} root=${fs.realpathSync(root)} link=${fs.realpathSync(path.join(root, 'escape'))}`);
    }
  });
  test("link realpath and closest-existing-parent escapes denied (injected filesystem)", () => {
    const escape = path.join(root, "escape");
    const fakeFs = {
      realpathSync(target) { return target === root ? root : target.startsWith(escape) ? outside : target; },
      lstatSync(target) {
        if (target.startsWith(path.join(escape, "new"))) throw Object.assign(Error("missing"), { code: "ENOENT" });
        return {};
      },
    };
    const context = vm.createContext({ fs: fakeFs, path, opts: { root }, HttpError });
    vm.runInContext(section("function resolvePath(", "function guardDestructiveDelete") + ";globalThis.resolve = resolvePath;", context);
    for (const name of ["escape/secret.txt", "escape/new/deep.txt"]) {
      assert.throws(() => context.resolve(name), (e) => e.code === "PATH_DENIED");
    }
  });
  const saved = await upload([Buffer.from("safe content")], "file.txt");
  test("upload succeeds and uses atomic temp replacement", () => {
    assert.equal(saved.status, 200); assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "safe content");
  });
  const large = await upload([Buffer.alloc(2048)], "file.txt");
  test("upload quota returns 413, preserves destination, removes partial", () => {
    assert.equal(large.status, 413); assert.equal(large.code, "UPLOAD_TOO_LARGE");
    assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "safe content");
    assert.ok(!fs.readdirSync(root).some((file) => file.includes(".part-")));
  });
  const dirFail = await upload([Buffer.from("x")], ".");
  test("upload to root directory is rejected without creating temp outside root", () => {
    assert.equal(dirFail.status, 400);
    assert.ok(!fs.readdirSync(temp).some((file) => file.includes(".part-")));
  });
  const abortReq = new Readable({ read() { this.push(Buffer.from("partial")); this.aborted = true; this.emit("aborted"); this.push(null); } });
  abortReq.aborted = false;
  const abortRes = { destroyed: false, headersSent: false };
  await fileContext.fileApi.handleUpload(abortReq, abortRes, new URL("http://localhost/upload?path=aborted.txt"));
  test("aborted upload cleans partial and does not publish destination", () => {
    assert.equal(abortRes.result.code, "UPLOAD_ABORTED");
    assert.ok(!fs.existsSync(path.join(root, "aborted.txt")));
    assert.ok(!fs.readdirSync(root).some((file) => file.includes(".part-")));
  });
  const realFs = fileContext.fs;
  fileContext.fs = { ...fs, createWriteStream() { return new Writable({ write(_chunk, _encoding, cb) { cb(Object.assign(Error("disk full"), { code: "ENOSPC" })); } }); } };
  const writeFail = await upload([Buffer.from("x")], "disk-full.txt");
  fileContext.fs = realFs;
  test("write stream failure returns structured error, no crash or partial", () => {
    assert.equal(writeFail.status, 500); assert.equal(writeFail.code, "ENOSPC");
    assert.ok(!fs.readdirSync(root).some((file) => file.includes(".part-")));
  });
  console.log(`\n${passed} checks passed (helpers simulated, real filesystem exercised)`);
} finally {
  // Every removal is confined to the known mkdtemp tree created above.
  fs.rmSync(temp, { recursive: true, force: true });
}
