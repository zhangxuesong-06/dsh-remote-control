/** Transport safety regressions. No real agents, credentials or external services.
 * node scripts/transport-safety-smoke.mjs            (compiled lib)
 * node scripts/transport-safety-smoke.mjs --source   (Node 24 native TS stripping)
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";

const source = process.argv.includes("--source");
if (source) {
  const sourceRoot = new URL("../src/", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(sourceRoot) && specifier === "./registry.js") {
        return nextResolve("./registry.ts", context);
      }
      return nextResolve(specifier, context);
    },
  });
}
const { RemoteClient } = await import(source ? "../src/agent-http.ts" : "../lib/agent-http.js");
const work = await mkdtemp(path.join(os.tmpdir(), "dsh-transport-safety-"));
const token = "synthetic-test-secret";
const servers = [];
let passes = 0;
async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}
function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function test(name, fn) {
  await fn();
  passes++;
  console.log(`PASS ${name}`);
}
async function expectError(operation, code) {
  let timer;
  try {
    await assert.rejects(Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("test deadline exceeded")), 3000); }),
    ]), (error) => error.code === code);
  } finally {
    clearTimeout(timer);
  }
}
function machine(port, more = {}) {
  return { id: "safety", name: "safety", host: "127.0.0.1", port, enabled: true, token, ...more };
}
function direct(port) { return { kind: "direct", host: "127.0.0.1", port }; }

let fallbackRequests = 0;
let primaryRequests = 0;
let capturedRedirectRequests = 0;
let mode = "ok";
const directTarget = await listen((req, res) => {
  fallbackRequests++;
  reply(res, 200, { ok: true, data: { version: "test", via: "direct" } });
});
const primary = await listen((req, res) => {
  primaryRequests++;
  req.resume();
  if (req.url === "/redirect-destination") {
    capturedRedirectRequests++;
    return reply(res, 200, { ok: true, data: {} });
  }
  if (mode === "remote-errno") return reply(res, 500, { ok: false, error: { code: "ECONNREFUSED", message: "remote result after execution" } });
  if (mode === "gateway-error") return reply(res, 502, { ok: false, error: { code: "GATEWAY_ERROR", message: "ambiguous upstream result" } });
  if (mode === "reset") return req.socket.destroy();
  if (mode === "redirect") {
    res.writeHead(307, { location: "/redirect-destination" });
    return res.end();
  }
  if (mode === "slow-headers") return;
  if (mode === "stalled-json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    return res.write('{"ok":true,"data":');
  }
  if (mode === "stalled-download") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.write("partial content");
  }
  if (mode === "broken-download") {
    res.writeHead(200, { "content-length": "1000000" });
    res.write("partial content");
    return setTimeout(() => res.destroy(), 40);
  }
  if (mode === "download") {
    res.writeHead(200, { "content-length": String(4 * 1024 * 1024) });
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    let sent = 0;
    function pump() {
      while (sent < 64 && !res.destroyed) {
        sent++;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      if (!res.destroyed) res.end();
    }
    return pump();
  }
  reply(res, 200, { ok: true, data: { version: "test", via: "primary" } });
});
const client = new RemoteClient(machine(primary.port, { paths: [direct(primary.port), direct(directTarget.port)] }), 250);

try {
  await test("disabled machine rejected before any network request", async () => {
    const count = primaryRequests;
    assert.throws(() => new RemoteClient(machine(primary.port, { enabled: false })), { code: "MACHINE_DISABLED" });
    const changed = machine(primary.port);
    const existingClient = new RemoteClient(changed);
    changed.enabled = false;
    await expectError(() => existingClient.health(250), "MACHINE_DISABLED");
    assert.equal(primaryRequests, count);
  });
  await test("tunnel followed by default direct host when tunnel connection refused", async () => {
    const closed = await listen((_req, res) => res.end());
    await new Promise((resolve) => closed.server.close(resolve));
    const tunneled = new RemoteClient(machine(directTarget.port, { tunnelUrl: closed.url }), 1000);
    const result = await tunneled.health(1000);
    assert.equal(result.via, "direct");
  });
  await test("actual pre-connect refusal can fail over a mutation", async () => {
    const closed = await listen((_req, res) => res.end());
    await new Promise((resolve) => closed.server.close(resolve));
    const fallback = new RemoteClient(machine(directTarget.port, { paths: [direct(closed.port), direct(directTarget.port)] }));
    const result = await fallback.request("POST", "/job/start", { command: "synthetic" }, 1000);
    assert.equal(result.via, "direct");
  });
  await test("remote errno envelope never replays a POST", async () => {
    mode = "remote-errno";
    const before = fallbackRequests;
    await expectError(() => client.request("POST", "/job/start", { command: "synthetic" }), "ECONNREFUSED");
    assert.equal(fallbackRequests, before);
  });
  await test("gateway failure never replays a POST", async () => {
    mode = "gateway-error";
    const before = fallbackRequests;
    await expectError(() => client.request("POST", "/exec", { command: "synthetic" }), "GATEWAY_ERROR");
    assert.equal(fallbackRequests, before);
  });
  await test("socket reset after request never replays a POST", async () => {
    mode = "reset";
    const before = fallbackRequests;
    await assert.rejects(client.request("POST", "/exec", { command: "synthetic" }));
    assert.equal(fallbackRequests, before);
  });
  await test("redirect rejected without forwarding credential-bearing POST", async () => {
    mode = "redirect";
    const before = fallbackRequests;
    await expectError(() => client.request("POST", "/exec", { command: "synthetic" }), "REDIRECT_REJECTED");
    assert.equal(capturedRedirectRequests, 0);
    assert.equal(fallbackRequests, before);
  });
  await test("header timeout never replays a mutation", async () => {
    mode = "slow-headers";
    const before = fallbackRequests;
    await expectError(() => client.request("POST", "/exec", { command: "synthetic" }), "TIMEOUT");
    assert.equal(fallbackRequests, before);
  });
  await test("JSON body deadline survives received headers", async () => {
    mode = "stalled-json";
    const before = fallbackRequests;
    await expectError(() => client.request("POST", "/exec", { command: "synthetic" }), "TIMEOUT");
    assert.equal(fallbackRequests, before);
  });
  await test("upload acknowledgement body has a deadline and no retry", async () => {
    mode = "stalled-json";
    const input = path.join(work, "upload.bin");
    await writeFile(input, "synthetic file");
    const before = fallbackRequests;
    await expectError(() => client.upload(input, "upload.bin", { timeoutMs: 250 }), "TIMEOUT");
    assert.equal(fallbackRequests, before);
  });
  await test("stalled streamed download preserves destination and removes partial", async () => {
    mode = "stalled-download";
    const output = path.join(work, "download.bin");
    await writeFile(output, "existing destination");
    await expectError(() => client.download("remote.bin", output, { timeoutMs: 250 }), "TIMEOUT");
    assert.equal(await readFile(output, "utf8"), "existing destination");
    assert.equal((await readdir(work)).filter((name) => name.includes(".part-")).length, 0);
  });
  await test("truncated body cleans partial and preserves destination", async () => {
    mode = "broken-download";
    const output = path.join(work, "download.bin");
    await assert.rejects(client.download("remote.bin", output, { timeoutMs: 1000 }));
    assert.equal(await readFile(output, "utf8"), "existing destination");
    assert.equal((await readdir(work)).filter((name) => name.includes(".part-")).length, 0);
  });
  await test("binary download streams correctly without whole-body arrayBuffer", async () => {
    mode = "download";
    const original = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = () => { throw new Error("whole-body buffering forbidden"); };
    try {
      const output = path.join(work, "download.bin");
      const result = await client.download("remote.bin", output, { timeoutMs: 2000 });
      assert.equal(result.sizeBytes, 4 * 1024 * 1024);
      const expected = createHash("sha256").update(Buffer.alloc(4 * 1024 * 1024, 0x5a)).digest("hex");
      assert.equal(createHash("sha256").update(await readFile(output)).digest("hex"), expected);
      assert.equal((await readdir(work)).filter((name) => name.includes(".part-")).length, 0);
    } finally {
      Response.prototype.arrayBuffer = original;
    }
  });
  console.log(`\n${passes}/${passes} transport safety checks passed (${source ? "source" : "compiled"}).`);
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  await rm(work, { recursive: true, force: true });
}
