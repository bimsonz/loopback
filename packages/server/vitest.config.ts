import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({ experimental: { newConfig: { configPath: "./test/cloudflare.config.ts" } } }),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
