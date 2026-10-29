import type { QuestionInput, ReviewInput, ServerEvent } from "@loopbackhq/protocol";
import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { REATTACH_WINDOW_MS } from "../src/domain/ask.ts";
import { AskNotFound } from "../src/domain/errors.ts";
import { spaceClient } from "../src/space/rpc.ts";
import { PRESENCE_GRACE_MS, Presence } from "../src/space/services.ts";

/** Who asks and replies in these tests, as the token gate names its one person. */
const OWNER = { id: "owner" };

const fresh = () => {
	const stub = exports.Space.get(exports.Space.idFromName(crypto.randomUUID()));
	return { stub, space: spaceClient(() => stub) };
};

const colour: QuestionInput = {
	question: "Which colour should the button be?",
	options: [{ label: "Red" }, { label: "Blue" }],
	project: "loopback",
};

const copy: ReviewInput = {
	title: "Landing page copy",
	content: [{ type: "markdown", text: "Ask your agent anything." }],
	project: "loopback",
};

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit)
		? exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error._tag] : []))
		: [];

describe("asks", () => {
	it.effect("opens a question awaiting the person", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ask = yield* space.open({
				actor: OWNER,
				kind: "question",
				input: colour,
				client: "test 1.0",
			});
			expect(ask).toMatchObject({
				kind: "question",
				status: "awaiting_human",
				project: "loopback",
				client: "test 1.0",
				thread: [],
				prompt: { question: colour.question, multiple: false },
			});
			const snapshot = yield* space.snapshot();
			expect(snapshot.open.map((open) => open.id)).toEqual([ask.id]);
			expect(snapshot.recent).toEqual([]);
		}),
	);

	it.effect("hands a reply over until the agent has taken it", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ask = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			const closed = yield* space.reply(ask.id, { outcome: "answered", selected: ["Blue"] }, OWNER);
			expect(closed.status).toBe("closed");
			expect(closed.closedAt).toBeDefined();
			const handed = yield* space.awaitReply(ask.id, 0);
			expect(handed).toEqual({
				askId: ask.id,
				reply: { outcome: "answered", selected: ["Blue"] },
				seq: 1,
			});
			// A wait cut off before the agent took the reply hands it over again.
			expect(yield* space.awaitReply(ask.id, 0)).toEqual(handed);
			yield* space.markDelivered(ask.id, 1);
			expect(yield* space.awaitReply(ask.id, 0)).toBeNull();
		}),
	);

	// 101 round trips into the space, one at a time: a second warm, several on a cold, busy runner.
	it.effect(
		"serves the space however many asks are open",
		() =>
			Effect.gen(function* () {
				const { space } = fresh();
				for (let n = 0; n < 101; n += 1) {
					yield* space.open({
						actor: OWNER,
						kind: "question",
						input: { question: `Question ${n}?`, project: "loopback" },
					});
				}
				expect((yield* space.snapshot()).open).toHaveLength(101);
			}),
		30_000,
	);

	it.live("holds a wait until the reply lands", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ask = yield* space.open({ actor: OWNER, kind: "review", input: copy });
			const waiting = yield* Effect.forkChild(space.awaitReply(ask.id, 10_000));
			yield* Effect.sleep("200 millis");
			expect((yield* space.get(ask.id)).waiting).toBe(true);
			yield* space.reply(ask.id, { outcome: "approved", note: "Ship it" }, OWNER);
			expect(yield* Fiber.join(waiting)).toEqual({
				askId: ask.id,
				reply: { outcome: "approved", note: "Ship it" },
				seq: 1,
			});
		}),
	);

	it.effect("answers null when no reply comes in time", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ask = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			expect(yield* space.awaitReply(ask.id, 50)).toBeNull();
		}),
	);

	it.effect("runs a follow-up round trip in one ask", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ask = yield* space.open({ actor: OWNER, kind: "review", input: copy });
			const asked = yield* space.reply(
				ask.id,
				{
					outcome: "follow_up",
					question: "Why this tone?",
				},
				OWNER,
			);
			expect(asked.status).toBe("awaiting_agent");
			expect(yield* space.awaitReply(ask.id, 0)).toMatchObject({
				reply: { outcome: "follow_up", question: "Why this tone?" },
			});
			const answered = yield* space.answerFollowUp({
				askId: ask.id,
				answer: "It matches the docs.",
			});
			expect(answered.status).toBe("awaiting_human");
			const again = yield* space.answerFollowUp({ askId: ask.id, answer: "It matches the docs." });
			expect(again.thread).toHaveLength(2);
			const approved = yield* space.reply(ask.id, { outcome: "approved" }, OWNER);
			expect(approved.status).toBe("closed");
			expect(approved.thread.map((entry) => entry.author)).toEqual(["human", "agent", "human"]);
		}),
	);

	it.effect("refuses a reply out of turn or after closing", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ask = yield* space.open({ actor: OWNER, kind: "review", input: copy });
			yield* space.reply(ask.id, { outcome: "follow_up", question: "Which page?" }, OWNER);
			expect(
				failureTag(yield* Effect.exit(space.reply(ask.id, { outcome: "approved" }, OWNER))),
			).toEqual(["NotYourTurn"]);
			yield* space.answerFollowUp({ askId: ask.id, answer: "The home page." });
			yield* space.reply(ask.id, { outcome: "dismissed" }, OWNER);
			expect(
				failureTag(yield* Effect.exit(space.reply(ask.id, { outcome: "approved" }, OWNER))),
			).toEqual(["AskClosed"]);
			expect(
				failureTag(yield* Effect.exit(space.answerFollowUp({ askId: ask.id, answer: "More." }))),
			).toEqual(["AskClosed"]);
		}),
	);

	it.effect("refuses replies that do not fit the ask", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const question = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			const review = yield* space.open({ actor: OWNER, kind: "review", input: copy });
			const refused = (askId: string, reply: Parameters<typeof space.reply>[1]) =>
				Effect.map(Effect.exit(space.reply(askId, reply, OWNER)), failureTag);
			expect(yield* refused(question.id, { outcome: "answered", selected: ["Green"] })).toEqual([
				"ReplyInvalid",
			]);
			expect(
				yield* refused(question.id, { outcome: "answered", selected: ["Red", "Blue"] }),
			).toEqual(["ReplyInvalid"]);
			expect(yield* refused(question.id, { outcome: "answered", selected: [], text: " " })).toEqual(
				["ReplyInvalid"],
			);
			expect(yield* refused(question.id, { outcome: "approved" })).toEqual(["ReplyInvalid"]);
			expect(yield* refused(review.id, { outcome: "answered", selected: [], text: "Hm" })).toEqual([
				"ReplyInvalid",
			]);
			expect(
				(yield* space.reply(
					question.id,
					{
						outcome: "answered",
						selected: [],
						text: "Green, please",
					},
					OWNER,
				)).status,
			).toBe("closed");
		}),
	);

	it.effect("refuses an ask too large to keep, saying so", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const huge = { type: "markdown", text: "x".repeat(300 * 1024) } as const;
			const review = yield* Effect.flip(
				space.open({ actor: OWNER, kind: "review", input: { ...copy, content: [huge] } }),
			);
			expect(review).toMatchObject({
				_tag: "ContentInvalid",
				reason: expect.stringMatching(/too large to show/),
			});
			const question = yield* Effect.flip(
				space.open({ actor: OWNER, kind: "question", input: { ...colour, context: huge.text } }),
			);
			expect(question).toMatchObject({ _tag: "ContentInvalid" });
		}),
	);

	it.effect("notes an agent waiting at most once a minute", () =>
		Effect.gen(function* () {
			const { stub, space } = fresh();
			const ask = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			const waitedAt = (at: string) =>
				Effect.promise(() =>
					runInDurableObject(stub, (_object, state) => {
						state.storage.sql.exec("UPDATE asks SET last_waited_at = ? WHERE id = ?", at, ask.id);
					}),
				);
			const lastWaited = Effect.promise(() =>
				runInDurableObject(
					stub,
					(_object, state) =>
						state.storage.sql
							.exec<{ last_waited_at: string }>(
								"SELECT last_waited_at FROM asks WHERE id = ?",
								ask.id,
							)
							.one().last_waited_at,
				),
			);
			const recently = new Date(Date.now() - 30_000).toISOString();
			yield* waitedAt(recently);
			yield* space.followTask(ask.id, 0);
			expect(yield* lastWaited).toBe(recently);
			const earlier = new Date(Date.now() - 90_000).toISOString();
			yield* waitedAt(earlier);
			yield* space.followTask(ask.id, 0);
			expect(yield* lastWaited).not.toBe(earlier);
		}),
	);

	it.effect("keeps typed errors across the RPC boundary", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			expect(yield* Effect.flip(space.get("missing"))).toEqual(
				new AskNotFound({ askId: "missing" }),
			);
		}),
	);

	it.live("retry a call a restart refused, on a fresh stub, where running it twice is safe", () =>
		Effect.gen(function* () {
			const { stub } = fresh();
			const refusals: Error[] = [];
			const stubs: number[] = [];
			/** A stub to the space whose next call is refused with `refusals[0]`, when there is one. */
			const flaky = () => {
				stubs.push(stubs.length);
				return {
					call: (method: Parameters<typeof stub.call>[0], args: readonly unknown[]) => {
						const refusal = refusals.shift();
						return refusal === undefined ? stub.call(method, args) : Promise.reject(refusal);
					},
				};
			};
			const space = spaceClient(flaky);
			const reset = () =>
				Object.assign(new Error("Durable Object reset because its code was updated."), {
					retryable: true,
				});

			refusals.push(reset());
			const ask = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			expect(stubs).toHaveLength(2);

			// A reply is not safe to send twice: a refused one is the caller's to resend.
			refusals.push(reset());
			const refused = yield* Effect.exit(space.reply(ask.id, { outcome: "dismissed" }, OWNER));
			expect(Exit.isFailure(refused) && Cause.hasDies(refused.cause)).toBe(true);
			expect((yield* space.get(ask.id)).status).toBe("awaiting_human");

			// An overloaded object is never retried, whatever the operation.
			refusals.push(Object.assign(reset(), { overloaded: true }));
			expect(Exit.isFailure(yield* Effect.exit(space.get(ask.id)))).toBe(true);
		}),
	);
});

describe("presence", () => {
	it.effect("shows an agent gone only once a grace passes with no lap or poll", () =>
		Effect.gen(function* () {
			const presence = yield* Presence;
			const gone: string[] = [];
			const leaves = (askId: string) => Effect.sync(() => void gone.push(askId));

			expect(yield* presence.begin("a")).toBe(true);
			yield* presence.end("a", leaves("a"));
			yield* TestClock.adjust(PRESENCE_GRACE_MS - 1);
			expect(presence.isWaiting("a")).toBe(true);
			yield* TestClock.adjust(1);
			expect(presence.isWaiting("a")).toBe(false);
			expect(gone).toEqual(["a"]);

			// A poll inside the grace keeps the agent there, and starts nothing new.
			yield* presence.begin("b");
			yield* presence.end("b", leaves("b"));
			yield* TestClock.adjust(PRESENCE_GRACE_MS / 2);
			expect(yield* presence.begin("b")).toBe(false);
			yield* TestClock.adjust(PRESENCE_GRACE_MS * 3);
			expect(presence.isWaiting("b")).toBe(true);
			expect(gone).toEqual(["a"]);

			// An agent that says it stopped is gone at once, with no grace.
			yield* presence.end("b", leaves("b"));
			expect(yield* presence.drop("b")).toBe(true);
			expect(presence.isWaiting("b")).toBe(false);
			yield* TestClock.adjust(PRESENCE_GRACE_MS);
			expect(gone).toEqual(["a"]);
		}).pipe(Effect.provide(Presence.layer)),
	);
});

describe("retries", () => {
	it.effect("rejoin the ask a dropped call opened", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const first = yield* space.open({
				actor: OWNER,
				kind: "question",
				input: colour,
				client: "test 1.0",
			});
			const retried = yield* space.open({
				actor: OWNER,
				kind: "question",
				input: colour,
				client: "test 1.0",
			});
			expect(retried.id).toBe(first.id);
			const other = yield* space.open({
				actor: OWNER,
				kind: "question",
				input: colour,
				client: "other 2.0",
			});
			expect(other.id).not.toBe(first.id);
		}),
	);

	it.effect("are only ever the same person's: two people asking alike get an ask each", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ada = { id: "person-1", name: "Ada" };
			const bea = { id: "person-2", name: "Bea" };
			const first = yield* space.open({ actor: ada, kind: "question", input: colour });
			const second = yield* space.open({ actor: bea, kind: "question", input: colour });
			expect(second.id).not.toBe(first.id);
			expect(first.raisedBy).toEqual(ada);
			expect(second.raisedBy).toEqual(bea);
			const answered = yield* space.reply(
				second.id,
				{ outcome: "answered", selected: ["Red"] },
				ada,
			);
			expect(answered.thread).toMatchObject([{ author: "human", by: ada }]);
		}),
	);

	it.effect("collect a reply given while no agent was listening", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const first = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			yield* space.reply(first.id, { outcome: "answered", selected: ["Red"] }, OWNER);
			const retried = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			expect(retried.id).toBe(first.id);
			const handed = yield* space.awaitReply(retried.id, 0);
			expect(handed).toMatchObject({ reply: { outcome: "answered", selected: ["Red"] } });
			// Until the agent takes the reply, asking again is still a retry.
			expect((yield* space.open({ actor: OWNER, kind: "question", input: colour })).id).toBe(
				first.id,
			);
			yield* space.markDelivered(retried.id, handed?.seq ?? 0);
			const asked = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			expect(asked.id).not.toBe(first.id);
		}),
	);

	it.effect("open a fresh ask once the window has passed", () =>
		Effect.gen(function* () {
			const { stub, space } = fresh();
			const first = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			const stale = new Date(Date.now() - REATTACH_WINDOW_MS - 1000).toISOString();
			yield* Effect.promise(() =>
				runInDurableObject(stub, (_object, state) => {
					state.storage.sql.exec("UPDATE asks SET last_waited_at = ?", stale);
				}),
			);
			const later = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			expect(later.id).not.toBe(first.id);
		}),
	);
});

describe("uploads", () => {
	it.effect("issue single-use tickets for the declared type", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const ticket = yield* space.createUpload("image/png");
			expect(failureTag(yield* Effect.exit(space.claimUpload(ticket.token, "image/jpeg")))).toEqual(
				["UploadRejected"],
			);
			expect(failureTag(yield* Effect.exit(space.claimUpload("not-a-token", "image/png")))).toEqual(
				["UploadNotFound"],
			);
			const claimed = yield* space.claimUpload(ticket.token, "image/png; charset=binary");
			expect(claimed.uploadId).toBe(ticket.uploadId);
			expect(failureTag(yield* Effect.exit(space.claimUpload(ticket.token, "image/png")))).toEqual([
				"UploadExpired",
			]);
			expect(failureTag(yield* Effect.exit(space.findUpload(ticket.uploadId)))).toEqual([
				"UploadNotFound",
			]);
			yield* space.completeUpload(ticket.uploadId, 1234);
			expect(yield* space.findUpload(ticket.uploadId)).toEqual({
				uploadId: ticket.uploadId,
				contentType: "image/png",
				size: 1234,
			});
		}),
	);

	it.effect("refuse an expired ticket", () =>
		Effect.gen(function* () {
			const { stub, space } = fresh();
			const ticket = yield* space.createUpload("image/webp");
			yield* Effect.promise(() =>
				runInDurableObject(stub, (_object, state) => {
					state.storage.sql.exec("UPDATE uploads SET expires_at = ?", new Date(0).toISOString());
				}),
			);
			expect(failureTag(yield* Effect.exit(space.claimUpload(ticket.token, "image/webp")))).toEqual(
				["UploadExpired"],
			);
		}),
	);

	it.effect("are the only images a review may show", () =>
		Effect.gen(function* () {
			const { space } = fresh();
			const shot: ReviewInput = {
				title: "Screenshot",
				content: [{ type: "image", uploadId: "nope" }],
				project: "loopback",
			};
			expect(
				failureTag(yield* Effect.exit(space.open({ actor: OWNER, kind: "review", input: shot }))),
			).toEqual(["ContentInvalid"]);
			const ticket = yield* space.createUpload("image/png");
			yield* space.claimUpload(ticket.token, "image/png");
			yield* space.completeUpload(ticket.uploadId, 10);
			const ask = yield* space.open({
				actor: OWNER,
				kind: "review",
				input: { ...shot, content: [{ type: "image", uploadId: ticket.uploadId }] },
			});
			expect(ask.kind).toBe("review");
		}),
	);
});

describe("event socket", () => {
	const connect = async (stub: DurableObjectStub) => {
		const response = await stub.fetch("http://space/events", {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "loopback.v1" },
		});
		expect(response.status).toBe(101);
		expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("loopback.v1");
		const socket = response.webSocket;
		if (socket === null) throw new Error("no socket");
		const frames: ServerEvent[] = [];
		const listeners = new Set<() => void>();
		socket.addEventListener("message", (event) => {
			frames.push(JSON.parse(String(event.data)));
			for (const listener of listeners) listener();
		});
		socket.accept();
		/** Resolves once `count` frames have arrived. */
		const until = (count: number) =>
			new Promise<ServerEvent[]>((resolve) => {
				const check = () => {
					if (frames.length >= count) {
						listeners.delete(check);
						resolve(frames.slice());
					}
				};
				listeners.add(check);
				check();
			});
		return { socket, until };
	};

	it.live("sends a snapshot, then every change", () =>
		Effect.gen(function* () {
			const { stub, space } = fresh();
			const existing = yield* space.open({ actor: OWNER, kind: "question", input: colour });
			const { socket, until } = yield* Effect.promise(() => connect(stub));
			const [first] = yield* Effect.promise(() => until(1));
			expect(first).toMatchObject({ type: "snapshot", snapshot: { open: [{ id: existing.id }] } });

			const review = yield* space.open({ actor: OWNER, kind: "review", input: copy });
			const waiting = yield* Effect.forkChild(space.awaitReply(review.id, 10_000));
			yield* Effect.sleep("200 millis");
			yield* space.reply(review.id, { outcome: "changes_requested", feedback: "Shorter." }, OWNER);
			yield* Fiber.join(waiting);

			const frames = yield* Effect.promise(() => until(4));
			expect(frames.slice(1, 4).map((frame) => frame.type)).toEqual([
				"ask.opened",
				"ask.updated",
				"ask.updated",
			]);
			expect(frames[1]).toMatchObject({ ask: { id: review.id, status: "awaiting_human" } });
			expect(frames[2]).toMatchObject({ ask: { id: review.id, waiting: true } });
			expect(frames[3]).toMatchObject({ ask: { id: review.id, status: "closed" } });
			socket.close();
		}),
	);

	it.effect("refuses anything but an upgrade", () =>
		Effect.gen(function* () {
			const { stub } = fresh();
			const response = yield* Effect.promise(() => stub.fetch("http://space/events"));
			expect(response.status).toBe(426);
		}),
	);
});
