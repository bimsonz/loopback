import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The inbox's component tests run in jsdom, without the Worker build the app's Vite config adds.
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["./test/setup.ts"],
	},
});
