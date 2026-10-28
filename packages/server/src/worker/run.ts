import type { Problem } from "@loopbackhq/protocol";
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger, ManagedRuntime } from "effect";
import { type WorkerBindings, WorkerEnv } from "./env.ts";
import { Files } from "./files.ts";
import { type Access, type Gate, NotConfigured } from "./gate.ts";
import { Spaces } from "./spaces.ts";

/** Everything a request handler may use. */
export type WorkerServices = Gate | Spaces | Files | WorkerEnv;

export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerServices, never>;

/** Who is calling, established once per request. */
export interface Caller {
	readonly access: Access | null;
	readonly requestId: string;
	readonly signal: AbortSignal;
}

export const problem = (code: string, message: string): Problem => ({ code, message });

/**
 * One runtime per environment, built only from binding-backed layers. Nothing request-scoped is
 * cached in it, so no request's pending work can be left for a later one to wait on. Configuration
 * is read from the environment, and logs are JSON, which Workers Logs indexes.
 */
export const runtimes = (gate: Layer.Layer<Gate, never, WorkerEnv>) => {
	const built = new WeakMap<object, WorkerRuntime>();
	return (env: WorkerBindings): WorkerRuntime => {
		let runtime = built.get(env);
		if (runtime === undefined) {
			runtime = ManagedRuntime.make(
				Layer.mergeAll(
					gate,
					Spaces.layer,
					Files.layer,
					ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
					Logger.layer([Logger.consoleJson]),
				).pipe(Layer.provideMerge(Layer.succeed(WorkerEnv, env))),
			);
			built.set(env, runtime);
		}
		return runtime;
	};
};

/**
 * A request that died rather than failing with a declared error: the deployment is not configured,
 * the request was abandoned, or something is broken. Thrown past the handler to `answerUnhandled`.
 */
export class Unhandled extends Error {
	override readonly name = "Unhandled";
	readonly defect: unknown;
	readonly interrupted: boolean;

	constructor(cause: Cause.Cause<unknown>) {
		const defect = Cause.squash(cause);
		super(defect instanceof Error ? defect.message : String(defect));
		this.defect = defect;
		this.interrupted = Cause.hasInterrupts(cause);
	}
}

/**
 * Runs a handler's effect on the runtime. Its error channel is `never`: every declared error has
 * already become a declared response. What remains dies: it is logged under the request's id, and
 * thrown as `Unhandled`. A request its client abandoned is only interrupted, and not logged.
 */
export const run = async <A>(
	runtime: WorkerRuntime,
	signal: AbortSignal,
	requestId: string,
	effect: Effect.Effect<A, never, WorkerServices>,
): Promise<A> => {
	const exit = await runtime.runPromiseExit(
		effect.pipe(
			Effect.tapCause((cause) =>
				Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Request died", cause),
			),
			Effect.annotateLogs({ requestId }),
		),
		{ signal },
	);
	if (Exit.isSuccess(exit)) return exit.value;
	throw new Unhandled(exit.cause);
};

/**
 * What the caller of a request that died is told: only its id. `run` has logged it already; anything
 * else that reached here died outside it, and is logged now.
 */
export const incident = (error: unknown, requestId: string): string => {
	if (!(error instanceof Unhandled)) {
		console.error(
			JSON.stringify({
				level: "ERROR",
				message: "Request died",
				requestId,
				cause:
					error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
			}),
		);
	}
	return `Something went wrong in Loopback. Incident ${requestId}.`;
};

/** What an unhandled request answers: a 500 naming a missing setting, or one with an incident id. */
export const answerUnhandled = (error: unknown, requestId: string): Response => {
	const defect = error instanceof Unhandled ? error.defect : error;
	if (defect instanceof NotConfigured) {
		return Response.json(problem("server.not_configured", defect.message), { status: 500 });
	}
	return Response.json(problem("server.defect", incident(error, requestId)), { status: 500 });
};
