import { Config, Effect, Layer, Option } from "effect";
import { createRemoteJWKSet, customFetch, errors, type JWTPayload, jwtVerify } from "jose";
import { z } from "zod";
import { Unauthorized } from "../domain/errors.ts";
import type { LoopbackBindings, WorkerBindings } from "./env.ts";
import { WorkerEnv } from "./env.ts";
import { type Access, credentialOf, Gate, makeTokenGate, NotConfigured } from "./gate.ts";

/** How a JWT gate checks a token, and how it reads the caller from the token's claims. */
export interface JwtGateOptions {
	/** Where the login publishes the keys it signs tokens with, as a JSON Web Key Set. */
	readonly jwksUrl: string;
	/** Fetches the key set in place of the global `fetch`: a service binding to the login, say. */
	readonly fetcher?: { readonly fetch: (url: string, init: RequestInit) => Promise<Response> };
	/** The `iss` every token must carry; MCP clients are sent here to sign in. */
	readonly issuer: string;
	/** The audiences a token may be for; it must carry at least one of them in `aud`. */
	readonly audience: ReadonlyArray<string>;
	/** The claim that names the space a token opens. A token without it opens nothing. */
	readonly spaceClaim: string;
	/** The claim that holds the caller's display name. `name` unless said otherwise. */
	readonly nameClaim?: string;
	/**
	 * Asked once a token has verified, with its claims and the caller they name: whether that caller
	 * may still come in. A login whose tokens outlive a membership or a grant answers here, returning
	 * the reason to refuse, which the caller is told, or nothing to let them in. A check that throws
	 * fails the request as a defect, like a key set out of reach.
	 */
	readonly check?: (claims: JWTPayload, access: Access) => Promise<string | undefined>;
}

/** The caller a token's claims name, read from the configured claims. */
const caller = z.object({
	sub: z.string().min(1),
	space: z.string().min(1),
});

/** The caller's display name, when the token carries a usable one; it never decides access. */
const nameOf = (claim: unknown): string | undefined =>
	typeof claim === "string" && claim.trim() !== "" ? claim : undefined;

/** The signature algorithms a token may use. `none` and the HMAC family are never among them. */
const ALGORITHMS = ["EdDSA", "ES256", "RS256"];

/** Failures that say the token is wrong, as opposed to the login's keys being out of reach. */
const refusals = [
	errors.JWTClaimValidationFailed,
	errors.JWTInvalid,
	errors.JWSInvalid,
	errors.JWSSignatureVerificationFailed,
	errors.JOSEAlgNotAllowed,
	errors.JOSENotSupported,
	errors.JWKSNoMatchingKey,
	errors.JWKSMultipleMatchingKeys,
];

/**
 * A gate for a deployment that serves a space per tenant behind any login that issues JWTs: a token
 * signed by one of the login's keys, from its issuer, for one of the audiences, opens the space its
 * claim names, as the person its `sub` names. Keys are fetched from the key set and cached by the
 * isolate. A key set out of reach is not the caller's fault, so it fails the request as a defect
 * rather than refusing it.
 */
export const makeJwtGate = (options: JwtGateOptions): Gate["Service"] => {
	const keys = createRemoteJWKSet(
		new URL(options.jwksUrl),
		options.fetcher === undefined
			? {}
			: { [customFetch]: (url: string, init: RequestInit) => options.fetcher!.fetch(url, init) },
	);
	const nameClaim = options.nameClaim ?? "name";
	return Gate.of({
		authenticate: Effect.fnUntraced(function* (request: Request) {
			const presented = credentialOf(request);
			if (presented === undefined) {
				return yield* new Unauthorized({ reason: "A bearer token is required." });
			}
			const verified = yield* Effect.tryPromise({
				try: () =>
					jwtVerify(presented, keys, {
						issuer: options.issuer,
						audience: [...options.audience],
						algorithms: ALGORITHMS,
					}),
				catch: (error) => error,
			}).pipe(
				Effect.catch((error) => {
					if (error instanceof errors.JWTExpired) {
						return Effect.fail(new Unauthorized({ reason: "The token has expired." }));
					}
					if (refusals.some((refusal) => error instanceof refusal)) {
						return Effect.fail(new Unauthorized({ reason: "The token is not valid." }));
					}
					return Effect.die(error);
				}),
			);
			const parsed = caller.safeParse({
				sub: verified.payload.sub,
				space: verified.payload[options.spaceClaim],
			});
			if (!parsed.success) {
				return yield* new Unauthorized({
					reason: `The token must name a person in \`sub\` and a space in \`${options.spaceClaim}\`.`,
				});
			}
			const { sub, space } = parsed.data;
			const name = nameOf(verified.payload[nameClaim]);
			const access: Access = { space, actor: name === undefined ? { id: sub } : { id: sub, name } };
			if (options.check !== undefined) {
				const check = options.check;
				const refusal = yield* Effect.promise(() => check(verified.payload, access));
				if (refusal !== undefined) return yield* new Unauthorized({ reason: refusal });
			}
			return access;
		}),
		authorizationServers: Effect.succeed([options.issuer]),
	});
};

/**
 * A JWT gate configured in code, from the Worker's environment: how a host composing Loopback uses
 * it. `options` may take the host's own environment type, such as the one `wrangler types` writes.
 */
// The parameter is what lets `options` take the host's own environment type: a function of that
// type does not accept every LoopbackBindings, so it could not be passed as one.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export const jwtGate = <Env extends LoopbackBindings = WorkerBindings>(
	options: (env: Env) => JwtGateOptions,
) =>
	Layer.effect(
		Gate,
		WorkerEnv.use((env) => Effect.sync(() => makeJwtGate(options(env as unknown as Env)))),
	);

/** The settings a JWT-gated deployment reads, and the token gate's secret. */
const SETTINGS = {
	token: "LOOPBACK_TOKEN",
	jwksUrl: "LOOPBACK_JWKS_URL",
	issuer: "LOOPBACK_JWT_ISSUER",
	audience: "LOOPBACK_JWT_AUDIENCE",
	spaceClaim: "LOOPBACK_SPACE_CLAIM",
	nameClaim: "LOOPBACK_NAME_CLAIM",
} as const;

const setting = (name: string) =>
	Config.option(Config.NonEmptyString(name)).pipe(
		Effect.catch(() => Effect.succeed(Option.none<string>())),
	);

const required = (name: string) =>
	setting(name).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.die(new NotConfigured(`${name} is not set; a JWT-gated deployment needs it.`)),
				onSome: Effect.succeed,
			}),
		),
	);

/** The JWT gate's options, from the deployment's settings. */
const configuredJwtOptions = Effect.gen(function* () {
	const nameClaim = yield* setting(SETTINGS.nameClaim);
	const options: JwtGateOptions = {
		jwksUrl: yield* required(SETTINGS.jwksUrl),
		issuer: yield* required(SETTINGS.issuer),
		audience: (yield* required(SETTINGS.audience))
			.split(",")
			.map((audience) => audience.trim())
			.filter((audience) => audience.length > 0),
		spaceClaim: yield* required(SETTINGS.spaceClaim),
		...(Option.isSome(nameClaim) ? { nameClaim: nameClaim.value } : {}),
	};
	return options;
});

/**
 * The gate a deployment's settings choose: the token gate when `LOOPBACK_TOKEN` is set, the JWT gate
 * when `LOOPBACK_JWKS_URL` is. Exactly one of them: both, or neither, is a deployment that cannot say
 * who anyone is, answered as a 500 that says so. Settings are read on first use, so a deployment whose
 * invoker vouches for every caller needs neither.
 */
export const ConfiguredGate = Layer.effect(
	Gate,
	Effect.gen(function* () {
		const chosen = yield* Effect.cached(
			Effect.gen(function* () {
				const token = yield* setting(SETTINGS.token);
				const jwks = yield* setting(SETTINGS.jwksUrl);
				if (Option.isSome(token) && Option.isSome(jwks)) {
					return yield* Effect.die(
						new NotConfigured(
							`Both ${SETTINGS.token} and ${SETTINGS.jwksUrl} are set. Set one: the token for a single space, or the JWT settings for a space per tenant.`,
						),
					);
				}
				if (Option.isSome(jwks)) return makeJwtGate(yield* configuredJwtOptions);
				return yield* makeTokenGate;
			}),
		);
		return Gate.of({
			authenticate: (request) => Effect.flatMap(chosen, (gate) => gate.authenticate(request)),
			authorizationServers: Effect.flatMap(chosen, (gate) => gate.authorizationServers),
		});
	}),
);
