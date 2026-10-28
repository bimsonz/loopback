import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ApiError, make } from "../src/index.ts";

/** A socket whose connection is always refused: an error, then a close, once listeners are on. */
const refusing = () => {
	const attempts: number[] = [];
	class Refused extends EventTarget {
		static readonly OPEN = 1;
		readyState = 0;
		constructor() {
			super();
			attempts.push(attempts.length);
			queueMicrotask(() => {
				this.readyState = 3;
				this.dispatchEvent(new Event("error"));
				this.dispatchEvent(new Event("close"));
			});
		}
		send() {}
		close() {}
	}
	return { attempts, WebSocket: Refused as unknown as typeof globalThis.WebSocket };
};

const notFetching = (() => Promise.reject(new Error("no network"))) as typeof globalThis.fetch;

/** A server that hands out event tickets, and nothing else. */
const ticketing = (async () =>
	Response.json(
		{ ticket: "space.pass", expiresAt: "2026-01-01T00:01:00.000Z" },
		{ status: 201 },
	)) as typeof globalThis.fetch;

/** Lets the test clock's moves and the socket's microtasks play out. */
const advance = (millis: number) =>
	Effect.gen(function* () {
		for (let step = 0; step < millis / 50; step += 1) {
			yield* TestClock.adjust("50 millis");
			yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
		}
	});

describe("the client, when things go wrong", () => {
	it.effect("waits longer after each refused connection", () =>
		Effect.gen(function* () {
			const socket = refusing();
			const client = make({
				baseUrl: "https://loopback.test",
				token: "t",
				fetch: ticketing,
				WebSocket: socket.WebSocket,
			});
			const following = yield* Effect.forkChild(Stream.runDrain(client.events));
			// Retries start at half a second and double, with jitter of at most a fifth either way,
			// so two seconds hold the first attempt and two retries, never a third.
			yield* advance(2_000);
			expect(socket.attempts).toHaveLength(3);
			yield* Fiber.interrupt(following);
		}),
	);

	it.effect("keeps reconnecting when a fresh token cannot be had", () =>
		Effect.gen(function* () {
			const socket = refusing();
			let asked = 0;
			const client = make({
				baseUrl: "https://loopback.test",
				token: () => {
					asked += 1;
					return asked === 1 ? Promise.reject(new Error("signed out")) : "t";
				},
				fetch: ticketing,
				WebSocket: socket.WebSocket,
			});
			const following = yield* Effect.forkChild(Stream.runDrain(client.events));
			yield* advance(1_000);
			expect(asked).toBeGreaterThan(1);
			expect(socket.attempts.length).toBeGreaterThan(0);
			yield* Fiber.interrupt(following);
		}),
	);

	it.effect("fails with an ApiError, never a defect, when a token or a body is unusable", () =>
		Effect.gen(function* () {
			const noToken = make({
				baseUrl: "https://loopback.test",
				token: () => Promise.reject(new Error("signed out")),
				fetch: notFetching,
			});
			const garbled = make({
				baseUrl: "https://loopback.test",
				token: "t",
				fetch: (async () => new Response("<html>", { status: 200 })) as typeof globalThis.fetch,
			});
			const attempts: readonly Effect.Effect<unknown, ApiError>[] = [
				noToken.whoami,
				garbled.whoami,
				noToken.reply("a", { outcome: "dismissed" }),
			];
			for (const attempt of attempts) {
				const exit = yield* Effect.exit(attempt);
				expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
				expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(ApiError);
			}
		}),
	);
});
