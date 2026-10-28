import { Config, Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";
import { Unauthorized } from "../domain/errors.ts";

/** Who a request is from, and which space it opens. */
export interface Access {
	readonly space: string;
	readonly actor: { readonly id: string; readonly name?: string };
}

/**
 * Decides who a request is from when no invoker has vouched for it. This is where a deployment plugs
 * in: the token gate below serves a single space behind one secret, and any other gate (one tenant
 * per space, OAuth, an edge identity header) is another layer providing this service.
 */
export class Gate extends Context.Service<
	Gate,
	{ readonly authenticate: (request: Request) => Effect.Effect<Access, Unauthorized> }
>()("loopback/Gate") {}

/** A deployment that cannot serve any request until it is configured. Answered as a 500 that says why. */
export class NotConfigured extends Error {
	override readonly name = "NotConfigured";
}

const vouched = z.strictObject({
	space: z.string().min(1),
	actor: z.strictObject({ id: z.string().min(1), name: z.string().min(1).optional() }),
});

/**
 * The access a Worker's invoker vouches for, when it does: `props.loopback`, as a Workers for
 * Platforms dispatcher or a service binding passes it in `ctx.props`. Only code deployed on the
 * account can set props, so nothing on the network can forge them, and they need no secret. Props
 * that say something else are a misconfigured invoker: refused, never passed over for the gate.
 */
export const vouchedAccess = (props: unknown): Effect.Effect<Access | undefined> => {
	const claim = (props as { readonly loopback?: unknown } | null | undefined)?.loopback;
	if (claim === undefined) return Effect.succeed(undefined);
	const parsed = vouched.safeParse(claim);
	if (!parsed.success) {
		return Effect.die(
			new NotConfigured("The invoker's props.loopback must be { space, actor: { id, name? } }."),
		);
	}
	const { space, actor } = parsed.data;
	return Effect.succeed({
		space,
		actor: actor.name === undefined ? { id: actor.id } : { id: actor.id, name: actor.name },
	});
};

/**
 * The bearer token a request presents. Only ever a header: Cloudflare redacts `Authorization` from
 * its logs, while a token sent any other way (a WebSocket subprotocol, say) would be logged in full.
 * Browsers open the event socket with a one-time ticket instead.
 */
export const credentialOf = (request: Request): string | undefined =>
	/^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];

const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

/** The space a token-gated deployment serves. */
export const DEFAULT_SPACE = "default";

/** The shortest token accepted: long enough that guessing it is hopeless. */
const MIN_TOKEN_LENGTH = 32;

/**
 * One secret, `LOOPBACK_TOKEN`, opens the deployment's single space. Compared in constant time over
 * digests, so neither the token's content nor its length leaks through timing. The secret is read,
 * as a redacted value no log can show, and digested once per isolate on first use: a deployment
 * whose invoker vouches for every caller never needs it.
 */
export const TokenGate = Layer.effect(
	Gate,
	Effect.gen(function* () {
		const expected = yield* Effect.cached(
			Effect.gen(function* () {
				const secret = yield* Config.Redacted("LOOPBACK_TOKEN").pipe(
					Effect.catch(() =>
						Effect.die(
							new NotConfigured(
								"LOOPBACK_TOKEN is not set. Deploy with it in a secrets file: `cf deploy --secrets-file <file>`.",
							),
						),
					),
				);
				if (Redacted.value(secret).length < MIN_TOKEN_LENGTH) {
					return yield* Effect.die(
						new NotConfigured(
							`LOOPBACK_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`,
						),
					);
				}
				return yield* Effect.promise(() => digest(Redacted.value(secret)));
			}),
		);
		return Gate.of({
			authenticate: (request) =>
				Effect.gen(function* () {
					const presented = credentialOf(request);
					if (presented === undefined) {
						return yield* new Unauthorized({ reason: "A bearer token is required." });
					}
					const wanted = yield* expected;
					const actual = yield* Effect.promise(() => digest(presented));
					if (!crypto.subtle.timingSafeEqual(wanted, actual)) {
						return yield* new Unauthorized({ reason: "The token is not valid." });
					}
					const access: Access = { space: DEFAULT_SPACE, actor: { id: "owner" } };
					return access;
				}),
		});
	}),
);
