import { Context } from "effect";

/** The bindings a Loopback Worker must declare, under these names. */
export interface LoopbackBindings {
	readonly FILES: R2Bucket;
}

/**
 * The Worker's environment as the runtime hands it over: Loopback's bindings, and whatever else the
 * deployment declares, which a gate may read (the token gate reads `LOOPBACK_TOKEN`).
 */
export type WorkerBindings = LoopbackBindings & Readonly<Record<string, unknown>>;

export class WorkerEnv extends Context.Service<WorkerEnv, WorkerBindings>()("loopback/WorkerEnv") {}
