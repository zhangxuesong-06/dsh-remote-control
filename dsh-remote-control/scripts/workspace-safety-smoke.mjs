import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { apply } from '../lib/index.js';
import { normalizeTunnelUrl, loadRegistry } from '../lib/registry.js';
const work = await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-safety-'));
const registryFile = path.join(work, 'machines.json');
let checks = 0, probes = 0;
const captured = [], tools = new Map(), routes = [], disposers = [];
function pass(name) { checks++; console.log(`PASS ${name}`); }
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : {};
  let result;
  if (req.url === '/health') {
    probes++; result = { version: '1.5.0', hostname: 'synthetic-host', platform: 'linux', runningJobs: 2 };
  } else if (req.url === '/fs') {
    result = data.op === 'stat' ? { exists: !data.path.includes('missing'), type: data.path.includes('file.txt') ? 'file' : 'directory' } : {};
  } else if (req.url === '/exec' || req.url === '/job/start') {
    captured.push({ endpoint: req.url, ...data });
    result = req.url === '/exec' ? { command: data.command, stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }
      : { id: 'job-synthetic', command: data.command, cwd: data.cwd, running: true };
  } else result = {};
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: result }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const ctx = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
  webServer: { register(spec) { routes.push(spec); return () => {}; } },
  logger: { info() {}, error(message) { throw new Error(message); } },
};
const invoke = (name, args) => tools.get(name).execute(args, {});
const registry = async () => JSON.parse(await readFile(registryFile, 'utf8'));
try {
  apply(ctx, { registryFile, defaultTimeoutMs: 3000, healthProbeTimeoutMs: 500,
    reverseListenHost: '127.0.0.1', reverseListenPort: 0, reverseProxyStart: 55000, reverseProxyCount: 5 });
  assert(tools.has('remote_machine_configure')); pass('configuration tool registered');
  await invoke('remote_machine_add', { id: 'a', host: '127.0.0.1', port, token: 'synthetic-a' });
  await invoke('remote_machine_add', { id: 'b', host: '127.0.0.1', port, token: 'synthetic-b', workspace: '/other' });
  await assert.rejects(invoke('remote_exec', { machine: 'a', command: 'pwd' }), /工作区/);
  assert.equal(captured.length, 0); pass('unset workspace blocks execution before network');
  await assert.rejects(invoke('remote_workspace', { machine: 'a', operation: 'set', path: '/repo/file.txt', create: false }), /不是目录/);
  assert.equal((await registry()).machines[0].workspace, undefined); pass('file cannot be selected as workspace');
  await invoke('remote_workspace', { machine: 'a', operation: 'set', path: '/repo', create: false });
  await invoke('remote_machine_configure', { machine: 'a', name: 'Build machine', auto_connect: true,
    default_cwd: 'build', default_env: { MODE: 'release', OVERRIDE: 'default' } });
  let a = (await registry()).machines.find(m => m.id === 'a');
  assert.equal(a.defaultCwd, '/repo/build'); assert.equal(a.name, 'Build machine'); assert.equal(a.autoConnect, true);
  pass('validated cwd and renamed host preserve stable id');
  await invoke('remote_exec', { machine: 'a', command: 'pwd', env: { OVERRIDE: 'call' } });
  assert.equal(captured.at(-1).cwd, '/repo/build'); assert.deepEqual(captured.at(-1).env, { MODE: 'release', OVERRIDE: 'call' });
  pass('saved cwd/env applied and per-call env takes precedence');
  await invoke('remote_exec_bg', { machine: 'a', command: 'build', cwd: '/explicit', env: { EXTRA: 'yes' } });
  assert.equal(captured.at(-1).cwd, '/explicit'); assert.equal(captured.at(-1).env.MODE, 'release'); pass('background execution shares explicit cwd and defaults');
  await assert.rejects(invoke('remote_machine_configure', { machine: 'a', default_cwd: '/missing' }), /不存在/);
  assert.equal((await registry()).machines.find(m => m.id === 'a').defaultCwd, '/repo/build'); pass('invalid cwd does not overwrite saved configuration');
  await invoke('remote_workspace', { machine: 'a', operation: 'set', path: '/newrepo', create: false });
  await invoke('remote_exec', { machine: 'a', command: 'pwd' });
  assert.equal(captured.at(-1).cwd, '/newrepo'); assert.equal((await registry()).machines.find(m => m.id === 'b').workspace, '/other');
  pass('workspace switch clears old cwd without changing another host');
  // 当前目标：UI 选定的电脑成为工具默认目标，显式 machine 仍优先，可切回本机。
  const apiSpec = routes.find(r => r.path === '/dsh-remote-control/api');
  const callApi = (path, method, body, headers = {}) => new Promise((resolve) => {
    let out = '';
    const res = { writeHead(code) { this.status = code; }, end(chunk) { out += chunk; resolve({ code: this.status, ...JSON.parse(out) }); } };
    const req = { url: '/dsh-remote-control/api' + path, method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', ...headers },
      on(event, cb) { if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (event === 'end') cb(); } };
    apiSpec.handler(req, res);
  });
  let state = await callApi('/state', 'GET');
  assert.equal(state.active.id, 'a'); pass('current target follows the machine last used');
  assert.equal((await callApi('/activate', 'POST', { machine: 'b' })).active.id, 'b');
  await invoke('remote_exec', { command: 'pwd' });
  assert.equal(captured.at(-1).cwd, '/other'); pass('selected host becomes the default target');
  await invoke('remote_exec', { machine: 'a', command: 'pwd' });
  assert.equal(captured.at(-1).cwd, '/newrepo'); pass('explicit machine still wins over selected host');
  state = await callApi('/state', 'GET');
  assert.equal(state.active.id, 'a'); pass('using a host updates the current target');
  assert.equal((await callApi('/activate', 'POST', { machine: '' })).active, null);
  await assert.rejects(invoke('remote_exec', { command: 'pwd' }), /未指定机器/);
  pass('clearing target returns to this computer and unqualified calls refuse');
  const list = await invoke('remote_machine_list', { refresh: true });
  assert(list.includes('繁忙 2')); assert(list.includes('最后在线')); pass('catalog reports running jobs and last seen');
  const previousProbes = probes;
  await invoke('remote_machine_list', {}); assert.equal(probes, previousProbes); pass('fresh catalog avoids repeated network probes');
  await invoke('remote_machine_list', { refresh: true }); assert(probes > previousProbes); pass('explicit refresh bypasses cache');
  const removal = await invoke('remote_machine_remove', { id: 'a' }); assert(removal.includes('未移除')); pass('online busy host removal refused');
  await invoke('remote_machine_configure', { machine: 'a', enabled: false });
  await assert.rejects(invoke('remote_exec', { machine: 'a', command: 'pwd' }), /停用/); pass('disabled machine rejects operations');
  await invoke('remote_machine_configure', { machine: 'a', enabled: true });
  await invoke('remote_machine_add', { id: 'a', host: '127.0.0.1', port });
  a = (await registry()).machines.find(m => m.id === 'a'); assert.equal(a.token, 'synthetic-a'); assert.equal(a.workspace, '/newrepo'); pass('reregistration preserves token and workspace');
  const api = routes.find(r => r.path === '/dsh-remote-control/api');
  let response;
  await api.handler({ url: '/dsh-remote-control/api/machines', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' } }, {
    writeHead(code) { this.code = code; }, end(body) { response = { code: this.code, ...JSON.parse(body) }; },
  });
  assert.equal(response.code, 200); assert.equal(response.ok, true);
  assert(!JSON.stringify(response).includes('synthetic-a')); assert(!JSON.stringify(response).includes('release'));
  pass('panel does not return credentials or default environment values');
  for (const [label, peer, headers] of [
    ['non-loopback peer', '192.0.2.10', { host: 'localhost' }],
    ['public host', '127.0.0.1', { host: 'public.example' }],
    ['forwarded tunnel', '127.0.0.1', { host: 'localhost', 'x-dsh-internal-tunnel': 'synthetic' }],
  ]) {
    await api.handler({ url: '/dsh-remote-control/api/machines', method: 'GET', socket: { remoteAddress: peer }, headers }, {
      writeHead(code) { this.code = code; }, end(body) { response = { code: this.code, ...JSON.parse(body) }; },
    });
    assert.equal(response.code, 403); pass(`settings API rejects ${label}`);
  }
  await api.handler({ url: '/dsh-remote-control/api/remove', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'https://untrusted.example', host: 'localhost' } }, {
    writeHead(code) { this.code = code; }, end(body) { response = { code: this.code, ...JSON.parse(body) }; },
  });
  assert.equal(response.code, 403); pass('cross-origin setting mutation rejected');
  assert.equal((await callApi('/activate', 'POST', { machine: 'a' })).active.id, 'a');
  await invoke('remote_machine_remove', { id: 'a', force: true });
  assert.deepEqual((await registry()).machines.map(m => m.id), ['b']);
  assert.equal((await callApi('/state', 'GET')).active, null);
  pass('explicit removal preserves other machines and clears stale target');
  for (const value of ['http://public.example', 'https://user:pass@public.example', 'https://public.example?q=secret']) assert.equal(normalizeTunnelUrl(value), undefined);
  assert.equal(normalizeTunnelUrl('https://public.example/base/'), 'https://public.example/base'); pass('tunnel URL prevents cleartext public credentials and stripped signed URLs');
  await writeFile(registryFile, '{broken');
  assert.throws(() => loadRegistry(registryFile), /拒绝覆盖/);
  await assert.rejects(invoke('remote_machine_add', { id: 'c', host: 'localhost' }), /拒绝覆盖/);
  assert.equal(await readFile(registryFile, 'utf8'), '{broken'); pass('corrupt registry fails closed without data loss');
  console.log(`\n${checks}/${checks} workspace/catalog safety checks passed`);
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  server.closeAllConnections(); await new Promise(r => server.close(r));
  await rm(work, { recursive: true, force: true });
}
