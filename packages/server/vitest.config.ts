import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						experimental: { newConfig: { configPath: "./test/cloudflare.config.ts" } },
					}),
				],
				test: {
					name: "workers",
					include: ["test/**/*.test.ts"],
					exclude: ["test/arch/**"],
				},
			},
			// The architecture rules read the source with the TypeScript compiler and the file system,
			// which workerd has neither of, so they run on Node. ArchUnitTS registers its matchers on
			// the global `expect`, so this project has globals.
			{
				test: {
					name: "arch",
					include: ["test/arch/**/*.test.ts"],
					environment: "node",
					globals: true,
					testTimeout: 30_000,
				},
			},
		],
	},
});
