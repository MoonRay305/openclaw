import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["index.ts"],
  outDir: "dist",
  platform: "node",
  format: "esm",
  deps: {
    neverBundle: (id) => id === "openclaw" || id.startsWith("openclaw/"),
  },
});
