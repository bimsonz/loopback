// The worker the server's tests run against: the library composed exactly as a deployment would.
import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

const name = "loopback-test";

export default defineConfig({
	worker: {
		name,
		entrypoint,
		compatibilityDate: "2026-10-19",
		compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
		env: {
			FILES: bindings.r2({ name }),
			LOOPBACK_TOKEN: bindings.text("test-token-0123456789abcdef0123456789"),
			// The Worker invoked with props, as another Worker vouching for its caller invokes it.
			VOUCHED: bindings.worker({
				worker: name,
				props: { loopback: { space: "vouched", actor: { id: "person-1", name: "Ada" } } },
			}),
			MISVOUCHED: bindings.worker({ worker: name, props: { loopback: { space: 7 } } }),
		},
		exports: { Space: exports.durableObject({ storage: "sqlite" }) },
	},
});
