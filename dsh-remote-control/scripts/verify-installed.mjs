import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
if (!dir) throw new Error('Pass installed plugin directory');
const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
const work = await mkdtemp(path.join(os.tmpdir(), 'dsh-installed-verify-'));
const tools = new Map(), routes = [], disposers = [], errors = [];
try {
  const mod = await import(pathToFileURL(path.join(dir, 'lib/index.js')).href);
  mod.apply({
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    tools: { register(def) { tools.set(def.name, def); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    logger: { info() {}, error(message) { errors.push(message); } },
  }, { registryFile: path.join(work, 'machines.json'), reverseListenHost: '127.0.0.1', reverseListenPort: 0,
    reverseProxyStart: 55000, reverseProxyCount: 5 });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(errors, []);
  assert(tools.has('remote_machine_configure'));
  assert(tools.has('remote_tunnel'));
  assert.equal(tools.size, 20);
  assert(routes.some(r => r.path === '/dsh-remote-control/api'));
  console.log(`Installed plugin ${pkg.version}: ${tools.size} tools and settings route verified; user registry untouched.`);
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  await rm(work, { recursive: true, force: true });
}


