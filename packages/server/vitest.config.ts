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
					// A runtime that has run one test file can crash starting the next (the pool's
					// connection to workerd closes with 1009, "Message is too large") once their module
					// graphs are large enough. With a slot for every file, no file starts in a runtime
					// another has used. Raise this past the number of test files as they grow.
					maxWorkers: 12,
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
					// Its own group, since it takes the default number of workers and the workers project
					// does not.
					sequence: { groupOrder: 1 },
				},
			},
		],
	},
});
