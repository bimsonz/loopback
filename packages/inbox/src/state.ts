import { type ApiError, initialInbox, type LoopbackApi, type Reply } from "@loopbackhq/sdk";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";

/**
 * Everything here is kept per client, so a host that switches the inbox to another space, by
 * handing over another client, starts afresh, and what the last one held is released.
 */

/** The inbox a client opens, followed live while anything renders it. */
export const inboxAtom = Atom.family((client: LoopbackApi) =>
	Atom.make(() => client.inbox, { initialValue: initialInbox }),
);

/** Who a client is signed in as: the person whose replies read as "you". */
export const meAtom = Atom.family((client: LoopbackApi) =>
	Atom.make(
		client.whoami.pipe(
			Effect.map((whoami) => whoami.actor.id),
			Effect.catch(() => Effect.succeed(undefined)),
		),
	),
);

/** Sends a reply to an ask. */
export const replyAtom = Atom.family((client: LoopbackApi) =>
	Atom.fn(
		(input: { readonly askId: string; readonly reply: Reply }): Effect.Effect<unknown, ApiError> =>
			client.reply(input.askId, input.reply),
	),
);

/** An uploaded image as an object URL, released when nothing shows it any more. */
export const imageAtom = Atom.family((client: LoopbackApi) =>
	Atom.family((uploadId: string) =>
		Atom.make(
			Effect.acquireRelease(
				Effect.map(client.file(uploadId), (blob) => URL.createObjectURL(blob)),
				(url) => Effect.sync(() => URL.revokeObjectURL(url)),
			),
		),
	),
);
