import type { Snapshot } from "@loopbackhq/protocol";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Ask } from "@loopbackhq/protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { ConfiguredGate, createLoopback, jwtGate, type JwtGateOptions } from "../src/index.ts";
import { spaceClient } from "../src/space/rpc.ts";

const ORIGIN = "https://loopback.test";
const BASE = `${ORIGIN}/api/v1`;
const ISSUER = "https://login.test";
const AUDIENCE = `${ORIGIN}/mcp`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const OWNER = { id: "owner" };

const login = await generateKeyPair("EdDSA", { extractable: true });
const stranger = await generateKeyPair("EdDSA", { extractable: true });
const jwks = { keys: [{ ...(await exportJWK(login.publicKey)), kid: "login-1", alg: "EdDSA" }] };

/** A token from the login, for `sub` in `workspace`, with any claim or header overridden. */
const token = (
	claims: Record<string, unknown> = {},
	{
		key = login.privateKey,
		issuer = ISSUER,
		audience = AUDIENCE,
		expires = "5m" as string | number,
		subject = "person-1" as string | null,
	} = {},
) => {
	const jwt = new SignJWT({ workspace: "acme", name: "Ada", ...claims })
		.setProtectedHeader({ alg: "EdDSA", kid: "login-1" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime(expires);
	return (subject === null ? jwt : jwt.setSubject(subject)).sign(key);
};

/**
 * A deployment whose gate takes the login's JWTs, its key set fetched however `fetchKeys` says, and
 * each verified caller put to `check` when there is one.
 */
const deployment = (
	fetchKeys: () => Promise<Response> = async () => Response.json(jwks),
	check?: JwtGateOptions["check"],
) => {
	const options: JwtGateOptions = {
		jwksUrl: JWKS_URL,
		fetcher: { fetch: fetchKeys },
		issuer: ISSUER,
		audience: ["https://app.login.test", AUDIENCE],
		spaceClaim: "workspace",
		...(check === undefined ? {} : { check }),
	};
	return createLoopback({ gate: jwtGate(() => options) });
};

/** Calls a deployment through its real `fetch`, with its own environment so it builds its own runtime. */
const call = async (
	app: ReturnType<typeof createLoopback>,
	path: string,
	init: RequestInit & { bearer?: string } = {},
	settings: Record<string, unknown> = env,
) => {
	const headers = new Headers(init.headers);
	if (init.bearer !== undefined) headers.set("Authorization", `Bearer ${init.bearer}`);
	const ctx = createExecutionContext();
	const response = await app.fetch(
		new Request(`${ORIGIN}${path}`, { ...init, headers }),
		{ ...(settings as typeof env) },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
};

const ask = (space: string, text: string) =>
	Effect.runPromise(
		spaceClient(() => exports.Space.getByName(space)).open({
			actor: OWNER,
			kind: "question",
			input: { question: text, options: [{ label: "Yes" }, { label: "No" }], project: "jwt-test" },
		}),
	);

describe("a JWT-gated deployment", () => {
	const app = deployment();

	it("opens the space the token's claim names, as the person its subject names", async () => {
		const response = await call(app, "/api/v1/whoami", { bearer: await token() });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			space: "acme",
			actor: { id: "person-1", name: "Ada" },
		});
	});

	it("refuses a request without a token, pointing MCP clients at its resource metadata", async () => {
		for (const path of ["/api/v1/whoami", "/mcp"]) {
			const response = await call(app, path, { method: path === "/mcp" ? "POST" : "GET" });
			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe(
				`Bearer realm="loopback", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
			);
		}
	});

	it("refuses a token from another issuer, for another audience, or signed by another key", async () => {
		const refused = [
			await token({}, { issuer: "https://elsewhere.test" }),
			await token({}, { audience: "https://elsewhere.test/mcp" }),
			await token({}, { key: stranger.privateKey }),
		];
		for (const bearer of refused) {
			const response = await call(app, "/api/v1/whoami", { bearer });
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ message: "The token is not valid." });
		}
	});

	it("refuses an expired token, saying so", async () => {
		const response = await call(app, "/api/v1/whoami", {
			bearer: await token({}, { expires: Math.floor(Date.now() / 1000) - 60 }),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ message: "The token has expired." });
	});

	it("refuses an unsigned token, and one signed with an algorithm it does not allow", async () => {
		const unsigned = new UnsecuredJWT({ workspace: "acme" })
			.setSubject("person-1")
			.setIssuer(ISSUER)
			.setAudience(AUDIENCE)
			.setExpirationTime("5m")
			.encode();
		const hmac = await new SignJWT({ workspace: "acme" })
			.setProtectedHeader({ alg: "HS256", kid: "login-1" })
			.setSubject("person-1")
			.setIssuer(ISSUER)
			.setAudience(AUDIENCE)
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("a-shared-secret-anyone-could-guess"));
		for (const bearer of [unsigned, hmac]) {
			expect((await call(app, "/api/v1/whoami", { bearer })).status).toBe(401);
		}
	});

	it("refuses a token that names no space or no person, never opening a default one", async () => {
		for (const bearer of [
			await token({ workspace: undefined }),
			await token({ workspace: "" }),
			await token({}, { subject: null }),
		]) {
			const response = await call(app, "/api/v1/whoami", { bearer });
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				message: "The token must name a person in `sub` and a space in `workspace`.",
			});
		}
	});

	it("keeps each space's asks, files and events to the tokens that name it", async () => {
		const opened = await ask("acme", "Only for acme?");
		const acme = await token({ workspace: "acme" });
		const globex = await token({ workspace: "globex" });

		expect((await call(app, `/api/v1/asks/${opened.id}`, { bearer: acme })).status).toBe(200);
		expect((await call(app, `/api/v1/asks/${opened.id}`, { bearer: globex })).status).toBe(404);
		const snapshot: Snapshot = await (
			await call(app, "/api/v1/snapshot", { bearer: globex })
		).json();
		expect(snapshot.open.map((item) => item.id)).not.toContain(opened.id);

		const upload = await Effect.runPromise(
			spaceClient(() => exports.Space.getByName("acme")).createUpload("image/png"),
		);
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
		const stored = await call(app, `/api/v1/uploads/${upload.spaceId}/${upload.token}`, {
			method: "PUT",
			body: png,
			headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) },
		});
		expect(stored.status).toBe(201);
		expect((await call(app, `/api/v1/files/${upload.uploadId}`, { bearer: acme })).status).toBe(
			200,
		);
		expect((await call(app, `/api/v1/files/${upload.uploadId}`, { bearer: globex })).status).toBe(
			404,
		);

		const socket = await call(app, "/api/v1/events", {
			bearer: globex,
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "loopback.v1" },
		});
		expect(socket.status).toBe(101);
		const first = new Promise<string>((resolve) =>
			socket.webSocket?.addEventListener("message", (event) => resolve(String(event.data)), {
				once: true,
			}),
		);
		socket.webSocket?.accept();
		const frame = JSON.parse(await first) as { type: string; snapshot: Snapshot };
		expect(frame.type).toBe("snapshot");
		expect(frame.snapshot.open.map((item) => item.id)).not.toContain(opened.id);
		socket.webSocket?.close();
	});

	it("records whose agent asked and who answered, for a space two people share", async () => {
		const settings = { ...env };
		const client = new Client({ name: "ada-agent", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
				fetch: async (url, init) => {
					const ctx = createExecutionContext();
					return app.fetch(new Request(url, init), settings, ctx);
				},
				requestInit: {
					headers: { Authorization: `Bearer ${await token({ workspace: "shared" })}` },
				},
			}),
		);
		const answered = client.callTool({
			name: "ask_question",
			arguments: {
				question: "Which colour?",
				options: [{ label: "Red" }, { label: "Blue" }],
				project: "jwt-test",
			},
		});

		const shared = spaceClient(() => exports.Space.getByName("shared"));
		let opened: Ask | undefined;
		for (let attempt = 0; opened === undefined && attempt < 100; attempt += 1) {
			opened = (await Effect.runPromise(shared.snapshot())).open.find(
				(item) => item.kind === "question" && item.prompt.question === "Which colour?",
			);
			if (opened === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (opened === undefined) throw new Error("The ask never opened.");
		expect(opened.raisedBy).toEqual({ id: "person-1", name: "Ada" });

		const bea = await token({ workspace: "shared", name: "Bea" }, { subject: "person-2" });
		const replied = await call(app, `/api/v1/asks/${opened.id}/reply`, {
			bearer: bea,
			method: "POST",
			body: JSON.stringify({ outcome: "answered", selected: ["Red"] }),
			headers: { "Content-Type": "application/json" },
		});
		expect(replied.status).toBe(200);
		await answered;
		const thread = (await Effect.runPromise(shared.get(opened.id))).thread;
		expect(thread).toMatchObject([{ author: "human", by: { id: "person-2", name: "Bea" } }]);
		await client.close();
	});

	it("serves protected resource metadata naming its login, at both well-known paths", async () => {
		for (const path of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
		]) {
			const response = await call(app, path);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				resource: AUDIENCE,
				authorization_servers: [ISSUER],
				bearer_methods_supported: ["header"],
				resource_name: "Loopback",
			});
		}
	});

	it("fails as a fault, not a refusal, when the login's keys are out of reach", async () => {
		const unreachable = deployment(async () => new Response("down", { status: 503 }));
		const response = await call(unreachable, "/api/v1/whoami", { bearer: await token() });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: "server.defect" });
	});
});

describe("a deployment whose frontend routes by space", () => {
	it("gives agents the inbox address the host builds, for the space their token names", async () => {
		const app = createLoopback({
			gate: jwtGate(() => ({
				jwksUrl: JWKS_URL,
				fetcher: { fetch: async () => Response.json(jwks) },
				issuer: ISSUER,
				audience: [AUDIENCE],
				spaceClaim: "workspace",
			})),
			inboxUrl: ({ origin, space, askId }) =>
				`${origin}/w/${space}${askId === undefined ? "" : `/asks/${askId}`}`,
		});
		const settings = { ...env };
		const client = new Client({ name: "ada-agent", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
				fetch: async (url, init) =>
					app.fetch(new Request(url, init), settings, createExecutionContext()),
				requestInit: {
					headers: { Authorization: `Bearer ${await token({ workspace: "team-7" })}` },
				},
			}),
		);
		const inbox = await client.callTool({ name: "open_inbox", arguments: {} });
		expect(inbox.structuredContent).toEqual({ url: `${ORIGIN}/w/team-7` });
		const one = await client.callTool({ name: "open_inbox", arguments: { askId: "ask-1" } });
		expect(one.structuredContent).toEqual({ url: `${ORIGIN}/w/team-7/asks/ask-1` });
		await client.close();
	});
});

describe("a host composing Loopback in code", () => {
	/** A host's environment as `wrangler types` writes it: an interface, with no index signature. */
	interface HostEnv {
		readonly FILES: R2Bucket;
		readonly LOGIN_ISSUER: string;
	}

	it("configures the gate from its own environment type, and serves through it", async () => {
		const app = createLoopback({
			gate: jwtGate((env: HostEnv) => ({
				jwksUrl: JWKS_URL,
				fetcher: { fetch: async () => Response.json(jwks) },
				issuer: env.LOGIN_ISSUER,
				audience: [AUDIENCE],
				spaceClaim: "workspace",
			})),
		});
		const host: HostEnv = { FILES: env.FILES, LOGIN_ISSUER: ISSUER };
		const response = await app.fetch(
			new Request(`${ORIGIN}/api/v1/whoami`, {
				headers: { Authorization: `Bearer ${await token()}` },
			}),
			host,
			createExecutionContext(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ space: "acme" });
	});
});

describe("a JWT-gated deployment whose host checks each caller", () => {
	const asked: Array<{ client: unknown; space: string; actor: string }> = [];
	const app = deployment(undefined, async (claims, access) => {
		asked.push({ client: claims["client_id"], space: access.space, actor: access.actor.id });
		if (access.actor.id === "removed") return "You are no longer a member of this workspace.";
		if (claims["client_id"] === "revoked-agent") return "This connection was revoked.";
		return undefined;
	});
	afterEach(() => {
		asked.length = 0;
	});

	it("lets in a caller the check passes, as the token names them", async () => {
		const response = await call(app, "/api/v1/whoami", {
			bearer: await token({ client_id: "agent-1" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			space: "acme",
			actor: { id: "person-1", name: "Ada" },
		});
		expect(asked).toEqual([{ client: "agent-1", space: "acme", actor: "person-1" }]);
	});

	it("refuses a caller the check turns away, with the check's reason, on REST and MCP", async () => {
		const removed = await token({}, { subject: "removed" });
		const revoked = await token({ client_id: "revoked-agent" });
		for (const path of ["/api/v1/whoami", "/mcp"]) {
			const method = path === "/mcp" ? "POST" : "GET";
			const gone = await call(app, path, { method, bearer: removed });
			expect(gone.status).toBe(401);
			expect(await gone.json()).toMatchObject({
				message: "You are no longer a member of this workspace.",
			});
			const cut = await call(app, path, { method, bearer: revoked });
			expect(cut.status).toBe(401);
			expect(await cut.json()).toMatchObject({ message: "This connection was revoked." });
		}
	});

	it("never asks the check about a token that did not verify", async () => {
		const response = await call(app, "/api/v1/whoami", {
			bearer: await token({}, { key: stranger.privateKey }),
		});
		expect(response.status).toBe(401);
		expect(asked).toEqual([]);
	});

	it("fails as a fault, not a refusal, when the check cannot answer", async () => {
		const broken = deployment(undefined, async () => {
			throw new Error("membership store down");
		});
		const response = await call(broken, "/api/v1/whoami", { bearer: await token() });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: "server.defect" });
	});
});

describe("a token-gated deployment", () => {
	it("serves no protected resource metadata, and a plain challenge", async () => {
		const metadata = await exports.default.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
		expect(metadata.status).toBe(404);
		const refused = await exports.default.fetch(`${BASE}/whoami`);
		expect(refused.headers.get("WWW-Authenticate")).toBe('Bearer realm="loopback"');
	});
});

describe("the gate a deployment's settings choose", () => {
	const configured = createLoopback({ gate: ConfiguredGate });
	const { LOOPBACK_TOKEN: _token, ...withoutToken } = env;
	const jwtSettings = {
		LOOPBACK_JWKS_URL: JWKS_URL,
		LOOPBACK_JWT_ISSUER: ISSUER,
		LOOPBACK_JWT_AUDIENCE: `https://app.login.test, ${AUDIENCE}`,
		LOOPBACK_SPACE_CLAIM: "workspace",
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is the JWT gate when the JWT settings are set, fetching the key set they name", async () => {
		const fetched: string[] = [];
		const real = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== JWKS_URL) return real(input, init);
			fetched.push(url);
			return Response.json(jwks);
		});
		const response = await call(
			configured,
			"/api/v1/whoami",
			{ bearer: await token({ workspace: "initech" }) },
			{ ...withoutToken, ...jwtSettings },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			space: "initech",
			actor: { id: "person-1", name: "Ada" },
		});
		expect(fetched).toEqual([JWKS_URL]);
	});

	it("refuses to choose when both the token and the JWT settings are set", async () => {
		const response = await call(
			configured,
			"/api/v1/whoami",
			{ bearer: await token() },
			{ ...env, ...jwtSettings },
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			code: "server.not_configured",
			message: expect.stringContaining("Both LOOPBACK_TOKEN and LOOPBACK_JWKS_URL are set"),
		});
	});

	it("names the JWT setting that is missing", async () => {
		const { LOOPBACK_JWT_ISSUER: _issuer, ...incomplete } = jwtSettings;
		const response = await call(
			configured,
			"/api/v1/whoami",
			{ bearer: await token() },
			{ ...withoutToken, ...incomplete },
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			code: "server.not_configured",
			message: "LOOPBACK_JWT_ISSUER is not set; a JWT-gated deployment needs it.",
		});
	});

	it("says how to configure either when neither is set", async () => {
		const response = await call(configured, "/api/v1/whoami", { bearer: "anything" }, withoutToken);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			message: expect.stringContaining("or set LOOPBACK_JWKS_URL"),
		});
	});
});
