import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@adt/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@adt/server": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      "@adt/test-support": fileURLToPath(
        new URL("../test-support/src/index.ts", import.meta.url),
      ),
    },
  },
});
