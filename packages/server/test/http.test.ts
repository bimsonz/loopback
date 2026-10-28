import type { Ask, ServerEvent } from "@loopbackhq/protocol";
import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { DEFAULT_SPACE, Gate, TokenGate, WorkerEnv } from "../src/index.ts";
import packageJson from "../package.json" with { type: "json" };
import { UploadIncomplete } from "../src/domain/errors.ts";
import { spaceClient } from "../src/space/rpc.ts";
import { Files } from "../src/worker/files.ts";

const TOKEN = env.LOOPBACK_TOKEN;
const BASE = "https://loopback.test/api/v1";
const space = spaceClient(() => exports.Space.get(exports.Space.idFromName(DEFAULT_SPACE)));
const spaceId = exports.Space.idFromName(DEFAULT_SPACE).toString();

const api = (path: string, init: RequestInit & { token?: string | null } = {}) => {
	const headers = new Headers(init.headers);
	const token = init.token === undefined ? TOKEN : init.token;
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	return exports.default.fetch(`${BASE}${path}`, { ...init, headers });
};

const json = (body: unknown) => ({
	method: "POST",
	body: JSON.stringify(body),
	headers: { "Content-Type": "application/json" },
});

const question = (text: string) =>
	space.open({
		kind: "question",
		input: { question: text, options: [{ label: "Yes" }, { label: "No" }], project: "http-test" },
	});

describe("the gate", () => {
	it("refuses a request without a token", async () => {
		const response = await api("/whoami", { token: null });
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
		expect(await response.json()).toMatchObject({ code: "auth.unauthorized" });
	});

	it("refuses a wrong token", async () => {
		expect((await api("/whoami", { token: "wrong" })).status).toBe(401);
	});

	it("opens the default space for the right one", async () => {
		const response = await api("/whoami");
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await response.json()).toEqual({ space: DEFAULT_SPACE });
	});

	const authenticateWith = (secret: string, presented = secret) =>
		Effect.exit(
			Effect.gen(function* () {
				const gate = yield* Gate;
				return yield* gate.authenticate(
					new Request("https://loopback.test", {
						headers: { Authorization: `Bearer ${presented}` },
					}),
				);
			}).pipe(
				Effect.provide(
					Layer.merge(
						TokenGate,
						ConfigProvider.layer(ConfigProvider.fromUnknown({ LOOPBACK_TOKEN: secret })),
					),
				),
			),
		);

	it.effect("dies, saying why, when no token is configured", () =>
		Effect.gen(function* () {
			const exit = yield* authenticateWith("", "a-token-the-caller-presents");
			expect(Exit.isFailure(exit) && String(exit.cause)).toContain("LOOPBACK_TOKEN is not set");
		}),
	);

	it.effect("dies, saying why, for a token too short to be safe", () =>
		Effect.gen(function* () {
			const exit = yield* authenticateWith("a1b2c3-d4._~");
			expect(Exit.isFailure(exit) && String(exit.cause)).toContain("openssl rand -hex 32");
			const long = "c2VjcmV0/+=c2VjcmV0/+=c2VjcmV0/+=c2VjcmV0";
			expect(Exit.isSuccess(yield* authenticateWith(long))).toBe(true);
		}),
	);
});

describe("an invoker that vouches for its caller", () => {
	it("opens the space it names, with no token", async () => {
		const response = await env.VOUCHED.fetch(`${BASE}/whoami`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ space: "vouched" });
	});

	it("is believed on the event socket too, with no ticket", async () => {
		const response = await env.VOUCHED.fetch(`${BASE}/events`, {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "loopback.v1" },
		});
		expect(response.status).toBe(101);
		response.webSocket?.accept();
		response.webSocket?.close();
	});

	it("is refused outright when what it vouches is malformed, even beside a good token", async () => {
		const response = await env.MISVOUCHED.fetch(`${BASE}/whoami`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: "server.not_configured" });
	});
});

describe("asks", () => {
	it("serves the snapshot an inbox starts from", async () => {
		const ask = await Effect.runPromise(question("Snapshot me?"));
		const response = await api("/snapshot");
		expect(response.status).toBe(200);
		const snapshot: { open: Ask[] } = await response.json();
		expect(snapshot.open.map((open) => open.id)).toContain(ask.id);
	});

	it("takes a reply, once", async () => {
		const ask = await Effect.runPromise(question("Reply to me?"));
		const replied = await api(
			`/asks/${ask.id}/reply`,
			json({ outcome: "answered", selected: ["Yes"] }),
		);
		expect(replied.status).toBe(200);
		expect(await replied.json()).toMatchObject({ id: ask.id, status: "closed" });
		const again = await api(`/asks/${ask.id}/reply`, json({ outcome: "dismissed" }));
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "ask.closed" });
	});

	it("answers 422 for a reply that does not fit, 400 for one the contract refuses", async () => {
		const ask = await Effect.runPromise(question("Fit me?"));
		const misfit = await api(`/asks/${ask.id}/reply`, json({ outcome: "approved" }));
		expect(misfit.status).toBe(422);
		expect(await misfit.json()).toMatchObject({ code: "reply.invalid" });
		const malformed = await api(`/asks/${ask.id}/reply`, json({ outcome: "maybe" }));
		expect(malformed.status).toBe(400);
		const extra = await api(`/asks/${ask.id}/reply`, json({ outcome: "dismissed", why: "no" }));
		expect(extra.status).toBe(400);
	});

	it("answers 404 for an ask that does not exist", async () => {
		expect((await api("/asks/nope")).status).toBe(404);
		expect((await api("/asks/nope/reply", json({ outcome: "dismissed" }))).status).toBe(404);
	});

	it("pages back through closed asks", async () => {
		for (const text of ["One?", "Two?", "Three?"]) {
			const ask = await Effect.runPromise(question(text));
			await api(`/asks/${ask.id}/reply`, json({ outcome: "dismissed" }));
		}
		const first = await api("/asks?limit=2");
		const page: { items: Ask[]; nextBefore?: string } = await first.json();
		expect(page.items).toHaveLength(2);
		expect(page.nextBefore).toBeDefined();
		const second = await api(`/asks?limit=2&before=${encodeURIComponent(page.nextBefore ?? "")}`);
		const next: { items: Ask[] } = await second.json();
		expect(next.items.map((item) => item.id)).not.toContain(page.items[0]?.id);
	});

	it("serves the OpenAPI document, naming the release it describes", async () => {
		const response = await api("/openapi.json", { token: null });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			openapi: "3.1.0",
			info: { version: packageJson.version },
		});
	});
});

describe("the event socket", () => {
	const upgrade = (protocols: string, headers: Record<string, string> = {}) =>
		exports.default.fetch(`${BASE}/events`, {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols, ...headers },
		});
	const ticket = async () => {
		const response = await api("/events/tickets", { method: "POST" });
		expect(response.status).toBe(201);
		const issued: { ticket: string; expiresAt: string } = await response.json();
		return issued.ticket;
	};

	it("opens once with a ticket, and streams the space", async () => {
		const pass = await ticket();
		const response = await upgrade(`loopback.v1, loopback.ticket.${pass}`);
		expect(response.status).toBe(101);
		expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("loopback.v1");
		const socket = response.webSocket;
		if (socket === null) throw new Error("no socket");
		const frames: ServerEvent[] = [];
		const arrived = new Promise<void>((resolve) => {
			socket.addEventListener("message", (event) => {
				frames.push(JSON.parse(String(event.data)));
				if (frames.length === 2) resolve();
			});
		});
		socket.accept();
		const ask = await Effect.runPromise(question("Stream me?"));
		await arrived;
		expect(frames[0]?.type).toBe("snapshot");
		expect(frames[1]).toMatchObject({ type: "ask.opened", ask: { id: ask.id } });
		socket.close();
		expect((await upgrade(`loopback.v1, loopback.ticket.${pass}`)).status).toBe(401);
	});

	it("opens for a client that sends the token as a header", async () => {
		const response = await upgrade("loopback.v1", { Authorization: `Bearer ${TOKEN}` });
		expect(response.status).toBe(101);
		response.webSocket?.accept();
		response.webSocket?.close();
	});

	it("refuses the token itself as a subprotocol, and any ticket it did not issue", async () => {
		expect((await upgrade("loopback.v1")).status).toBe(401);
		expect((await upgrade(`loopback.v1, loopback.token.${TOKEN}`)).status).toBe(401);
		expect((await upgrade("loopback.v1, loopback.ticket.nonsense")).status).toBe(401);
		expect((await upgrade(`loopback.v1, loopback.ticket.${spaceId}.forged`)).status).toBe(401);
	});

	it("refuses a ticket once its minute is up", async () => {
		const pass = await ticket();
		await runInDurableObject(
			exports.Space.get(exports.Space.idFromName(DEFAULT_SPACE)),
			(_o, state) => {
				state.storage.sql.exec(
					"UPDATE event_tickets SET expires_at = ?",
					"2000-01-01T00:00:00.000Z",
				);
			},
		);
		expect((await upgrade(`loopback.v1, loopback.ticket.${pass}`)).status).toBe(401);
	});

	it("refuses a plain request", async () => {
		expect((await api("/events")).status).toBe(426);
	});
});

describe("uploads", () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const put = (token: string, body: BodyInit, type = "image/png", id = spaceId) =>
		exports.default.fetch(`${BASE}/uploads/${id}/${token}`, {
			method: "PUT",
			body,
			headers: { "Content-Type": type },
		});

	it("stores an image once, without credentials, and serves it to the space", async () => {
		const ticket = await Effect.runPromise(space.createUpload("image/png"));
		const stored = await put(ticket.token, png);
		expect(stored.status).toBe(201);
		expect(await stored.json()).toEqual({
			uploadId: ticket.uploadId,
			contentType: "image/png",
			size: png.byteLength,
		});
		expect((await put(ticket.token, png)).status).toBe(410);

		const file = await api(`/files/${ticket.uploadId}`);
		expect(file.status).toBe(200);
		expect(file.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
		expect((await api(`/files/${ticket.uploadId}`, { token: null })).status).toBe(401);
	});

	it("refuses the wrong type, an unknown ticket, and an unknown space", async () => {
		const ticket = await Effect.runPromise(space.createUpload("image/png"));
		const wrongType = await put(ticket.token, png, "image/gif");
		expect(wrongType.status).toBe(422);
		expect(await wrongType.json()).toMatchObject({ code: "upload.rejected" });
		expect((await put("unknown", png)).status).toBe(404);
		expect((await put(ticket.token, png, "image/png", "f".repeat(64))).status).toBe(404);
		expect((await put(ticket.token, png, "image/png", "not-an-id")).status).toBe(404);
	});

	it("refuses an image over the limit, leaving the ticket for one that fits", async () => {
		const ticket = await Effect.runPromise(space.createUpload("image/png"));
		const response = await put(ticket.token, new Uint8Array(ticket.maxBytes + 1));
		expect(response.status).toBe(413);
		expect((await put(ticket.token, png)).status).toBe(201);
	});

	describe("into R2", () => {
		const store = (bucket: R2Bucket, body: Uint8Array, length: number) =>
			Effect.runPromiseExit(
				Effect.gen(function* () {
					const files = yield* Files;
					yield* files.put("k", new Blob([body]).stream(), length, "image/png");
				}).pipe(
					Effect.provide(
						Files.layer.pipe(Layer.provide(Layer.succeed(WorkerEnv, { ...env, FILES: bucket }))),
					),
				),
			);
		const draining = {
			put: async (_key: string, value: ReadableStream) => {
				await new Response(value).arrayBuffer();
			},
		} as unknown as R2Bucket;

		it("calls a body shorter than it declared incomplete", async () => {
			const exit = await store(draining, png, png.byteLength + 5);
			expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(UploadIncomplete);
		});

		it("treats R2 failing as a fault, not as the image's", async () => {
			const failing = {
				put: async (_key: string, value: ReadableStream) => {
					await value.cancel();
					throw new Error("R2 is down");
				},
			} as unknown as R2Bucket;
			const exit = await store(failing, png, png.byteLength);
			expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
		});
	});

	it("answers 404 for a file that was never stored", async () => {
		const ticket = await Effect.runPromise(space.createUpload("image/png"));
		expect((await api(`/files/${ticket.uploadId}`)).status).toBe(404);
	});
});
