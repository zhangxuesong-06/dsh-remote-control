#!/usr/bin/env node
/**
 * Verifies where the client panel is registered.
 *
 * The panel lives in the left sidebar (sidebar.panellist + main) so it sits next to
 * Plugins and Scheduled Tasks instead of inside Settings. This test loads the built
 * ModuleLoader bundle with a stub host, then asserts:
 *   - sidebar.panellist and main are registered with the same id/key
 *   - the label and order are what the sidebar needs
 *   - the settings.section fallback is NOT used when the sidebar slots exist
 *   - the composer target control still registers
 *   - when the sidebar slots are missing, it falls back to settings.section
 *   - the icon/page components render without throwing
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_ID = "dsh-remote-control";

// Minimal React stand-in: registration never invokes hooks, rendering does.
const fakeReact = {
  Fragment: "Fragment",
  createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
  useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
  useEffect() {},
  useMemo(fn) { return fn(); },
  useRef(v) { return { current: v }; },
  useCallback(fn) { return fn; },
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { captured = def; },
  },
};

await import(new URL("../lib/client.js", import.meta.url).href);
assert.ok(captured, "bundle called ModuleLoader.load");
assert.equal(captured.id, "@dsh-external/dsh-remote-control");

const requireStub = (name) => {
  if (name === "react") return fakeReact;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Menu: function Menu() {}, MenuLabel: function () {} };
  throw new Error(`unexpected external: ${name}`);
};

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`PASS ${label}`);
  else { console.log(`FAIL ${label}`); failures += 1; }
};

function loadModule() {
  const mod = captured.factory(requireStub);
  assert.equal(typeof mod.apply, "function", "module exports apply");
  assert.deepEqual(mod.inject, ["slots"], "module injects slots");
  return mod;
}

function runApply(mod, { sidebar = true } = {}) {
  const regs = [];
  const ctx = {
    effect(fn) { fn(); },
    slots: {
      inject(name, cb) {
        if (!sidebar && (name === "sidebar.panellist" || name === "main")) {
          throw new Error(`slot ${name} unavailable`);
        }
        return cb();
      },
      register(opts, component) {
        regs.push({ opts, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  return regs;
}

// ── primary path: panel in the sidebar ───────────────────────────────────────
{
  const mod = loadModule();
  const regs = runApply(mod);
  const sidebar = regs.find((r) => r.opts.name === "sidebar.panellist");
  const main = regs.find((r) => r.opts.name === "main");
  const settings = regs.find((r) => r.opts.name === "settings.section");
  const input = regs.find((r) => r.opts.name === "conversation.input.left");

  check(Boolean(sidebar), "sidebar.panellist entry registered");
  check(sidebar?.opts.id === PANEL_ID, "sidebar entry id matches the panel id");
  check(typeof sidebar?.opts.label === "function" && sidebar.opts.label() === "远程控制", "sidebar label is 远程控制");
  check(sidebar?.opts.order === 20, "sidebar order places it after Plugins/Schedule");
  check(Boolean(main), "main page registered");
  check(main?.opts.key === PANEL_ID, "main key matches the sidebar entry id");
  check(!settings, "settings.section is not used when the sidebar is available");
  check(Boolean(input), "composer target control still registers");

  // Render the sidebar icon and the page; both must produce an element.
  // The registered component may wrap the real icon, so resolve one function layer.
  let icon = sidebar?.component({ size: 16 });
  if (icon && typeof icon.type === "function") icon = icon.type(icon.props ?? { size: 16 });
  check(Boolean(icon) && icon.type === "svg", "sidebar icon renders an svg");
  const page = main?.component({});
  check(Boolean(page), "panel page renders");
}

// ── fallback: host without the sidebar slots ────────────────────────────────
{
  const mod = loadModule();
  const originalError = console.error;
  console.error = () => {}; // the fallback path logs a warning by design
  const regs = runApply(mod, { sidebar: false });
  console.error = originalError;
  const settings = regs.find((r) => r.opts.name === "settings.section");
  check(Boolean(settings), "falls back to settings.section when sidebar slots are missing");
  check(settings?.opts.id === PANEL_ID, "fallback keeps the same id");
}

console.log(`\n${failures === 0 ? "panel placement checks passed" : failures + " check(s) failed"}`);
process.exit(failures === 0 ? 0 : 1);
