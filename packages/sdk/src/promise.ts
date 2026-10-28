import type { Ask, AskPage, Reply, Snapshot, Whoami } from "@loopbackhq/protocol";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { type ApiError, type LoopbackConfig, make } from "./client.ts";
import { type InboxState, initialInbox } from "./inbox.ts";

/** The inbox as an external store: the shape React's `useSyncExternalStore` takes, and any other framework can. */
export interface InboxStore {
	/** Starts following the inbox with the first listener and stops after the last leaves. */
	readonly subscribe: (listener: () => void) => () => void;
	/** The current state. The same object until something changes. */
	readonly getSnapshot: () => InboxState;
}

/** The Loopback client for code that does not use Effect: every call is a promise. */
export interface LoopbackPromiseClient {
	readonly whoami: () => Promise<Whoami>;
	readonly snapshot: () => Promise<Snapshot>;
	readonly ask: (id: string) => Promise<Ask>;
	readonly history: (page?: {
		readonly before?: string;
		readonly limit?: number;
	}) => Promise<AskPage>;
	readonly reply: (id: string, reply: Reply) => Promise<Ask>;
	readonly file: (uploadId: string) => Promise<Blob>;
	readonly inbox: InboxStore;
}

/** Runs a call, rejecting with the `ApiError` itself so callers can match on it. */
const settle = async <A>(effect: Effect.Effect<A, ApiError>): Promise<A> => {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
};

export const createLoopbackClient = (config: LoopbackConfig): LoopbackPromiseClient => {
	const api = make(config);
	const listeners = new Set<() => void>();
	let state = initialInbox;
	let following: Fiber.Fiber<void> | undefined;

	const inbox: InboxStore = {
		subscribe: (listener) => {
			listeners.add(listener);
			following ??= Effect.runFork(
				api.inbox.pipe(
					Stream.runForEach((next) =>
						Effect.sync(() => {
							state = next;
							for (const notify of listeners) notify();
						}),
					),
				),
			);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0 && following !== undefined) {
					Effect.runFork(Fiber.interrupt(following));
					following = undefined;
					state = initialInbox;
				}
			};
		},
		getSnapshot: () => state,
	};

	return {
		whoami: () => settle(api.whoami),
		snapshot: () => settle(api.snapshot),
		ask: (id) => settle(api.ask(id)),
		history: (page) => settle(api.history(page)),
		reply: (id, reply) => settle(api.reply(id, reply)),
		file: (uploadId) => settle(api.file(uploadId)),
		inbox,
	};
};
