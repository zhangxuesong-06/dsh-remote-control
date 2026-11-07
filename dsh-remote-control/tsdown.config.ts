import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: ["esm"],
  platform: "browser",
  clean: false,
  dts: false,
  sourcemap: false,
});
