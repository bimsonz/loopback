import { Data, Effect, type Exit, Schedule, Schema } from "effect";
import {
	AskClosed,
	AskNotFound,
	ContentInvalid,
	NotYourTurn,
	ReplyInvalid,
	TicketInvalid,
	UploadExpired,
	UploadNotFound,
	UploadRejected,
} from "../domain/errors.ts";
import { type Operations, operations } from "./operations.ts";

/** Every error a space operation fails with. */
export const SpaceFailure = Schema.Union([
	AskNotFound,
	AskClosed,
	NotYourTurn,
	ReplyInvalid,
	ContentInvalid,
	TicketInvalid,
	UploadNotFound,
	UploadExpired,
	UploadRejected,
]);
export type SpaceFailure = typeof SpaceFailure.Type;

/**
 * An operation's outcome as it crosses the RPC boundary. Errors do not survive structured clone
 * with their tags, so every answer is its Exit encoded as JSON; a defect crosses as its name and
 * message. Success values are the contract's own JSON shapes and pass through unchanged.
 */
export type ExitJson = Schema.Json;

// A defect keeps its stack across the hop, so it is logged where it happened: this codec only ever
// runs between the Worker and its own Durable Object, never towards a client.
let codec: Schema.Codec<Exit.Exit<Schema.Json, SpaceFailure>, Schema.Json> | undefined;
const exitCodec = () =>
	(codec ??= Schema.toCodecJson(
		Schema.Exit(Schema.Json, SpaceFailure, Schema.Defect({ includeStack: true })),
	));

export const encodeExit = (exit: Exit.Exit<unknown, SpaceFailure>): ExitJson =>
	Schema.encodeSync(exitCodec())(exit as Exit.Exit<Schema.Json, SpaceFailure>);

const decodeExit = (json: unknown) => Schema.decodeUnknownSync(exitCodec())(json);

/** A space operation by name, as the object serves it. */
export type OperationName = keyof Operations;

/** What the Worker holds to reach a space: its object's single RPC entry point. */
export interface SpaceStub {
	call(method: OperationName, args: readonly unknown[]): Promise<ExitJson>;
}

/** A space's operations as seen from the Worker: the same signatures, with no services required. */
export type SpaceClient = {
	readonly [K in OperationName]: (
		...args: Parameters<Operations[K]>
	) => Effect.Effect<
		Effect.Success<ReturnType<Operations[K]>>,
		Effect.Error<ReturnType<Operations[K]>>
	>;
};

/**
 * Operations that are safe to run twice: reads, and writes that leave the space as the first run
 * did. Only these are retried. A reply, an upload ticket, or an upload claim is not: a second run
 * is refused, or issues another.
 */
const idempotent: ReadonlySet<OperationName> = new Set<OperationName>([
	"open",
	"answerFollowUp",
	"awaitReply",
	"markDelivered",
	"followTask",
	"cancelTask",
	"get",
	"snapshot",
	"history",
	"findUpload",
]);

/** A call the object never answered: it was reset (by a deploy, say), or the transport failed. */
class Refused extends Data.TaggedError("Refused")<{ readonly cause: unknown }> {
	/** Whether Cloudflare marks it safe to try again: retryable, and not because the object is overloaded. */
	get retryable(): boolean {
		const flags = this.cause as { readonly retryable?: unknown; readonly overloaded?: unknown };
		return flags?.retryable === true && flags.overloaded !== true;
	}
}

/** A deploy resets every space; its new instance is up within moments. */
const RETRY = {
	schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
	times: 5,
	while: (refused: Refused) => refused.retryable,
};

/**
 * The typed client for one space. Each call is decoded back into the operation's own success value
 * or tagged error. A call the object refused is tried again on a fresh stub when it is safe to, as
 * Cloudflare advises; otherwise it is a defect.
 */
export const spaceClient = (stub: () => SpaceStub): SpaceClient =>
	Object.fromEntries(
		(Object.keys(operations) as OperationName[]).map((method) => {
			const once = (args: readonly unknown[]) =>
				Effect.tryPromise({
					try: () => stub().call(method, args),
					catch: (cause) => new Refused({ cause }),
				});
			return [
				method,
				(...args: unknown[]) =>
					(idempotent.has(method) ? Effect.retry(once(args), RETRY) : once(args)).pipe(
						Effect.catchTag("Refused", (refused) => Effect.die(refused.cause)),
						Effect.flatMap((json) => decodeExit(json)),
					),
			];
		}),
	) as unknown as SpaceClient;
