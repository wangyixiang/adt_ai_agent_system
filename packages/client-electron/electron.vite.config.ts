import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// The daemon (`@adt/client-daemon`) and `@adt/shared` are workspace packages whose
// entry points are TypeScript, so they must be **bundled** into main — everything
// else (electron, `ws`, …) stays external and is resolved from node_modules.
const workspaceTs = ["@adt/client-daemon", "@adt/shared"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceTs })],
    build: {
      rollupOptions: {
        // A Node builtin the daemon loads at runtime (`ledger.ts` uses
        // `createRequire`); keep it out of the bundle explicitly.
        external: ["node:sqlite"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceTs })],
  },
  renderer: {
    plugins: [react()],
  },
});
