/**
 * Client-boot smoke test: simulate window.__ModuleLoader__ (as the web client
 * loader does), load client.js, invoke its factory with a fake React require,
 * and run apply() against a fake slots ctx. Verifies the panel registration
 * path cannot throw during client boot.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let handoff = null;
globalThis.window = {
  __ModuleLoader__: {
    load(h) {
      handoff = h;
    },
  },
};

try {
  await import(pathToFileURL(path.join(DIR, "..", "lib", "client.js")).href);
  check("module loader handoff", handoff && handoff.id === "@dsh-external/dsh-remote-control", handoff?.id);

  const fakeReact = {
    createElement: (...args) => args,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  };
  const mod = handoff.factory((name) => (name === "react" ? fakeReact : undefined));
  check("client exports", typeof mod?.apply === "function" && mod.inject.includes("slots"), "apply + inject");

  let registered = null;
  let componentFactory = null;
  let injectCall = null;
  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    slots: {
      inject: (kind, cb) => {
        injectCall = kind;
        const reg = cb();
        registered = reg;
        return () => {};
      },
      register: (spec, component) => {
        componentFactory = component;
        return spec;
      },
    },
  };
  mod.apply(ctx);
  check("section injected", injectCall === "settings.section", injectCall);
  check("section registered", registered?.id === "dsh-remote-control" && registered?.order === 28, JSON.stringify({ id: registered?.id, order: registered?.order }));
  check("component passed as 2nd arg", typeof componentFactory === "function", "component factory via register(spec, component)");
} catch (error) {
  check("unexpected error", false, error?.message ?? String(error));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
