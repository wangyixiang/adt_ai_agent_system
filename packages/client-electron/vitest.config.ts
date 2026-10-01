import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
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
