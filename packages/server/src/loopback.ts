import type { Layer } from "effect";
import type { WorkerBindings, WorkerEnv } from "./worker/env.ts";
import type { Gate } from "./worker/gate.ts";
import { makeApp } from "./worker/http.ts";
import { runtimes } from "./worker/run.ts";

export interface LoopbackOptions {
	/** Decides who each request is from and which space it opens. */
	readonly gate: Layer.Layer<Gate, never, WorkerEnv>;
}

/**
 * A Loopback Worker's `fetch` handler. The deployment exports it as its default, beside the `Space`
 * Durable Object class declared with SQLite storage, and binds `FILES`.
 */
export const createLoopback = (options: LoopbackOptions) => {
	const app = makeApp(runtimes(options.gate));
	return {
		fetch: (request: Request, env: WorkerBindings, ctx: ExecutionContext) =>
			app.fetch(request, env, ctx),
	} satisfies ExportedHandler<WorkerBindings>;
};
