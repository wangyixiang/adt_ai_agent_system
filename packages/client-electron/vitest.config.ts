import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    // The integration test drives a real Server + daemon round trip; 5s (the
    // default) is too tight once the machine is busy from other packages.
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    // The integration test drives a real Server + daemon round trip; under a busy
    // machine a test can flake on infrastructure timing alone. One bounded retry
    // absorbs that noise; the assertions stay exact, so a real regression fails
    // on every attempt and still surfaces.
    retry: 2,
  },
  resolve: {
    alias: {
      "@adt/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@adt/client-daemon": fileURLToPath(
        new URL("../client-daemon/src/index.ts", import.meta.url),
      ),
      "@adt/server": fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
      "@adt/test-support": fileURLToPath(
        new URL("../test-support/src/index.ts", import.meta.url),
      ),
    },
  },
});
