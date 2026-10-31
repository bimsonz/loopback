import type { Layer } from "effect";
import type { LoopbackBindings, WorkerBindings, WorkerEnv } from "./worker/env.ts";
import type { Gate } from "./worker/gate.ts";
import { makeApp } from "./worker/http.ts";
import { defaultInboxUrl, type InboxLink } from "./worker/mcp.ts";
import { runtimes } from "./worker/run.ts";
import { Spaces } from "./worker/spaces.ts";

export interface LoopbackOptions {
	/** Decides who each request is from and which space it opens. */
	readonly gate: Layer.Layer<Gate, never, WorkerEnv>;
	/**
	 * How requests reach their spaces. The Worker's own `Space` objects unless said otherwise: a host
	 * wraps `Spaces.layer` to meter what its tenants open, or to decline it with a reason.
	 */
	readonly spaces?: Layer.Layer<Spaces, never, WorkerEnv>;
	/**
	 * Where the person reads and answers a space's asks, which `open_inbox` gives agents. This
	 * Worker's own inbox unless said otherwise: a host whose frontend lives elsewhere, or routes by
	 * space, says where.
	 */
	readonly inboxUrl?: (link: InboxLink) => string;
}

/**
 * A Loopback Worker's `fetch` handler. The deployment exports it as its default, beside the `Space`
 * Durable Object class declared with SQLite storage, and binds `FILES`.
 */
export const createLoopback = (options: LoopbackOptions) => {
	const app = makeApp(
		runtimes(options.gate, options.spaces ?? Spaces.layer),
		options.inboxUrl ?? defaultInboxUrl,
	);
	return {
		// Any environment that declares Loopback's bindings: the host's own type, such as the one
		// `wrangler types` writes, need not say it holds nothing else.
		fetch: (request: Request, env: LoopbackBindings, ctx: ExecutionContext) =>
			app.fetch(request, env as unknown as WorkerBindings, ctx),
	} satisfies ExportedHandler<LoopbackBindings>;
};
