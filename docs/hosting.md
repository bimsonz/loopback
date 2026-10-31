# Hosting Loopback for many people

One Loopback deployment can serve many tenants. Every space is its own Durable Object with its own
SQLite database, so tenants never share storage, and what decides which space a request opens is the
deployment's gate. The token gate opens a single space behind one secret. The JWT gate opens a space
per tenant behind any login that issues JWTs (your own, Better Auth, Auth0, WorkOS, Clerk, Cloudflare
Access), reading the space and the person from each token's claims.

Loopback ships no login of its own. People sign in to yours; Loopback checks what it issued.

## Point Loopback at your login

The JWT gate is chosen by its settings. None of them is a secret, so declare them as text in
`apps/loopback/cloudflare.config.ts`, in place of the token's secret:

```ts
env: {
	FILES: bindings.r2(),
	LOOPBACK_JWKS_URL: bindings.text("https://login.example.com/.well-known/jwks.json"),
	LOOPBACK_JWT_ISSUER: bindings.text("https://login.example.com"),
	LOOPBACK_JWT_AUDIENCE: bindings.text("https://loopback.example.com/mcp"),
	LOOPBACK_SPACE_CLAIM: bindings.text("org_id"),
},
```

| Setting                 | What it is                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `LOOPBACK_JWKS_URL`     | Where your login publishes the keys it signs tokens with, as a JSON Web Key Set. |
| `LOOPBACK_JWT_ISSUER`   | The `iss` every token must carry. MCP clients are sent here to sign in.          |
| `LOOPBACK_JWT_AUDIENCE` | The audiences a token may be for, comma-separated. It must carry one in `aud`.   |
| `LOOPBACK_SPACE_CLAIM`  | The claim that names the space a token opens: an organisation or workspace id.   |
| `LOOPBACK_NAME_CLAIM`   | Optional. The claim holding the person's display name; `name` unless you say so. |

Set either `LOOPBACK_TOKEN` or the JWT settings, never both: a deployment with both, or neither,
answers every request with a 500 that says which to set.

## What a token must carry

- A signature by one of the key set's keys, with EdDSA, ES256 or RS256. Unsigned tokens and shared
  secrets are refused.
- `iss`, `aud` and `exp`, checked against the settings and the clock.
- `sub`, the person. It becomes the actor Loopback records on what they ask and answer.
- The space claim, a non-empty string. A token without it is refused, never sent to a default space.

Everyone whose token names a space shares it: they see the same inbox, each ask records whose agent
raised it (`raisedBy`), and each reply records who gave it (`by`). An expired token is refused with a
message saying so, so a client knows to refresh it. If the key set cannot be fetched, the request
fails as a fault, not a refusal.

## Agents sign in with OAuth

With the JWT gate, Loopback is an OAuth protected resource, as the MCP specification asks. A refused
request carries a challenge naming its protected resource metadata (RFC 9728):

```
WWW-Authenticate: Bearer realm="loopback", resource_metadata="https://loopback.example.com/.well-known/oauth-protected-resource/mcp"
```

That document names your issuer as the authorization server, so an MCP client goes there to sign the
person in. Your login then needs to be an OAuth 2.1 authorization server: authorization server
metadata, PKCE with `S256`, client registration through Client ID Metadata Documents (or dynamic
client registration), and tokens issued for the resource the client asks for, so `aud` is
`https://<your deployment>/mcp`. Agents connect with no token to paste:

```sh
claude mcp add --transport http loopback https://loopback.example.com/mcp
```

then sign in with `/mcp` in Claude Code.

The inbox page this repository deploys signs in with a pasted credential, which suits the token
gate. Behind a login, render the inbox in your own app with
[`@loopbackhq/inbox`](../packages/inbox/README.md), handing it a client from
[`@loopbackhq/sdk`](../packages/sdk/README.md) whose `token` is a function that returns a fresh JWT;
the SDK calls it for every request.

## Compose Loopback in your own Worker

A service that wraps Loopback (adding its own routes, billing or limits) imports the server and
composes it with its own layers. The `Space` class must be exported beside the handler:

```ts
import { createLoopback, Declined, jwtGate, Spaces } from "@loopbackhq/server";
import { Effect, Layer } from "effect";

export { Space } from "@loopbackhq/server";

// Wrap the spaces to meter what tenants open, or decline it with a reason the agent is shown.
// `overLimit` stands for your own check against the tenant's plan.
const limited = Layer.effect(
	Spaces,
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		return Spaces.of({
			...spaces,
			of: (access) => {
				const space = spaces.of(access);
				return {
					...space,
					open: (request) =>
						overLimit(access.space)
							? Effect.fail(new Declined({ reason: "This month's asks are used. Upgrade at …" }))
							: space.open(request),
				};
			},
		});
	}),
).pipe(Layer.provide(Spaces.layer));

const loopback = createLoopback({
	// The key set fetched through a service binding to the login, rather than over the internet.
	gate: jwtGate((env) => ({
		jwksUrl: "https://login.example.com/.well-known/jwks.json",
		fetcher: env.AUTH as Fetcher,
		issuer: "https://login.example.com",
		audience: ["https://app.example.com", "https://app.example.com/mcp"],
		spaceClaim: "workspace",
		// Asked after each token verifies: return a reason to turn the caller away, or nothing.
		// `isMember` stands for your own lookup, which should be cached.
		check: async (_claims, access) =>
			(await isMember(access.actor.id, access.space))
				? undefined
				: "You are no longer a member of this workspace.",
	})),
	spaces: limited,
	// Where `open_inbox` sends people, when your frontend is not this Worker's own inbox.
	inboxUrl: ({ origin, space, askId }) =>
		`${origin}/w/${space}${askId === undefined ? "" : `/asks/${askId}`}`,
});
```

Route `/api/v1/*`, `/mcp` and `/.well-known/oauth-protected-resource*` to `loopback.fetch`. Only
`open` and `createUpload` may be declined; the agent receives the reason as its tool's error.

A JWT outlives whatever it was issued on: a membership, or an agent's grant. `check` is where a
login that can take those back says so, before the token's expiry. It sees every claim, such as the
OAuth client a token was issued to. A check that throws fails the request with a 500, as an
unreachable key set does, since the caller is not at fault.

To remove a tenant, `eraseSpace(env, space)` deletes everything its space holds: asks, threads,
tickets, and the files its uploads stored. Inboxes watching it are closed, and the space carries on
empty. Running it again finishes what a failed run left.

Another Worker on the same account can also vouch for a caller without any token, by invoking
Loopback through a service binding with `props.loopback = { space, actor: { id, name? } }`. Only code
deployed on the account can set props, and props that say anything else are refused with a 500.

## Upgrading

One deploy upgrades every tenant. A deploy resets each space's Durable Object; agents following
background tasks simply poll again, and a call waiting on a reply is retried on a fresh stub. Schema
migrations run in each space when it next starts, and only forward: a release that adds one cannot be
rolled back past it. Confirm a deployment from outside with `GET /api/v1/openapi.json`, which names
the release in `info.version`.
