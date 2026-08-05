import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// ref: https://developers.cloudflare.com/workers/testing/vitest-integration/
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
