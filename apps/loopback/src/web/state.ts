import { type ApiError, initialInbox, make, type LoopbackApi, type Reply } from "@loopbackhq/sdk";
import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

const TOKEN_KEY = "loopback.token";

const readToken = (): string | null => {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
};

/** Remembers the token in this browser, or forgets it. */
const storeToken = (token: string | null) => {
	try {
		if (token === null) localStorage.removeItem(TOKEN_KEY);
		else localStorage.setItem(TOKEN_KEY, token);
	} catch {
		// Storage can be unavailable (a private window); the token then lasts for this tab only.
	}
};

/**
 * The token this inbox connects with, if it has one. Setting it remembers it in this browser, so the
 * two never disagree. Kept for the whole session, read or not.
 */
export const tokenAtom = Atom.keepAlive(
	Atom.writable(
		(): string | null => readToken(),
		(ctx, token: string | null) => {
			storeToken(token);
			ctx.setSelf(token);
		},
	),
);

const clientFor = (token: string): LoopbackApi => make({ baseUrl: location.origin, token });

/** A client that sends no credential, for a page whose host already signs its requests in. */
const hostedClient = (): LoopbackApi => make({ baseUrl: location.origin });

/**
 * Whether the page's host already signs requests in, as a hosted deployment's dispatcher does: then
 * no token is needed. Asked only while no token is held.
 */
export const hostedAtom = Atom.make(
	Effect.suspend(() => hostedClient().whoami).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	),
);

/** The client for the current token, or for the host's session when it has signed the person in. */
export const clientAtom = Atom.readable((get): LoopbackApi | null => {
	const token = get(tokenAtom);
	if (token !== null) return clientFor(token);
	return AsyncResult.getOrElse(get(hostedAtom), () => false) ? hostedClient() : null;
});

/** The inbox, followed live while anything renders it. */
export const inboxAtom = Atom.make(
	(get) => {
		const client = get(clientAtom);
		return client === null ? Stream.empty : client.inbox;
	},
	{ initialValue: initialInbox },
);

/** Who the inbox is signed in as: the person whose replies read as "you". */
export const meAtom = Atom.make((get) => {
	const client = get(clientAtom);
	return client === null
		? Effect.succeed(undefined)
		: client.whoami.pipe(
				Effect.map((whoami) => whoami.actor.id),
				Effect.catch(() => Effect.succeed(undefined)),
			);
});

/** Checks a token before keeping it: the space it opens, or why it was refused. */
export const signInAtom = Atom.fn((token: string) =>
	Effect.map(clientFor(token).whoami, (whoami) => ({ token, space: whoami.space })),
);

/** Sends a reply to an ask. */
export const replyAtom = Atom.fn(
	(
		input: { readonly askId: string; readonly reply: Reply },
		get,
	): Effect.Effect<unknown, ApiError> => {
		const client = get(clientAtom);
		return client === null
			? Effect.die(new Error("Not signed in."))
			: client.reply(input.askId, input.reply);
	},
);

/** An uploaded image as an object URL, released when nothing shows it any more. */
export const imageAtom = Atom.family((uploadId: string) =>
	Atom.make((get) => {
		const client = get(clientAtom);
		if (client === null) return Effect.die(new Error("Not signed in."));
		return Effect.acquireRelease(
			Effect.map(client.file(uploadId), (blob) => URL.createObjectURL(blob)),
			(url) => Effect.sync(() => URL.revokeObjectURL(url)),
		);
	}),
);
