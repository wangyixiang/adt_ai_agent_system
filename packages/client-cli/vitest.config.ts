import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // The e2e drives one real server and one daemon; running files in parallel
    // would have them fight over the shared database.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@adt/client-daemon": fileURLToPath(
        new URL("../client-daemon/src/index.ts", import.meta.url),
      ),
      "@adt/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@adt/server": fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
      "@adt/test-support": fileURLToPath(
        new URL("../test-support/src/index.ts", import.meta.url),
      ),
    },
  },
});
