import { Effect, Option } from "effect";
import { type Context, Hono } from "hono";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { registerRoutes, type Operations } from "../generated/app.gen.ts";
import { openApiDocument } from "../generated/document.gen.ts";
import type { AppEnv, RouteDeps } from "../generated/runtime.gen.ts";
import type { WorkerBindings } from "./env.ts";
import { fileKey, Files } from "./files.ts";
import { type Access, Gate, vouchedAccess } from "./gate.ts";
import {
	answerUnhandled,
	type Caller,
	problem,
	run,
	type WorkerRuntime,
	type WorkerServices,
} from "./run.ts";
import { UPLOAD_MAX_BYTES } from "../space/operations.ts";
import { VERSION } from "../version.ts";
import { makeMcp } from "./mcp.ts";
import { Spaces } from "./spaces.ts";

declare module "../generated/runtime.gen.ts" {
	interface AppEnv {
		readonly Bindings: WorkerBindings;
		readonly Variables: { readonly access: Access; readonly requestId: string };
	}
}

/** The contract, naming the release that serves it, so a deployment can be checked from outside. */
const document = { ...openApiDocument, info: { ...openApiDocument.info, version: VERSION } };

/** How many closed asks a history page holds when the caller does not say. */
const DEFAULT_PAGE = 20;

/**
 * A refused request's 401. When the gate takes credentials from an authorization server, the
 * challenge says where its protected resource metadata is, so an MCP client can go and sign in.
 */
const unauthorized = (message: string, resourceMetadata?: string) =>
	Response.json(problem("auth.unauthorized", message), {
		status: 401,
		headers: {
			"WWW-Authenticate":
				resourceMetadata === undefined
					? 'Bearer realm="loopback"'
					: `Bearer realm="loopback", resource_metadata="${resourceMetadata}"`,
		},
	});

/** Where the MCP endpoint's protected resource metadata is (RFC 9728): the well-known path, then its path. */
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** The prefix a browser puts its event ticket behind in `Sec-WebSocket-Protocol`. */
const TICKET_PROTOCOL_PREFIX = "loopback.ticket.";

/** The event ticket a socket upgrade offers, split into the space it names and its secret. */
const ticketOf = (request: Request) => {
	const ticket = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
		.split(",")
		.map((protocol) => protocol.trim())
		.find((protocol) => protocol.startsWith(TICKET_PROTOCOL_PREFIX))
		?.slice(TICKET_PROTOCOL_PREFIX.length);
	if (ticket === undefined) return undefined;
	const dot = ticket.indexOf(".");
	return { spaceId: ticket.slice(0, dot), secret: ticket.slice(dot + 1) };
};

/**
 * Who a request is from. The Worker's invoker vouches first, when it does; otherwise the
 * deployment's gate decides from the request itself. A refusal is the 401 to answer with.
 */
const authenticate = (
	runtime: WorkerRuntime,
	request: Request,
	props: unknown,
	requestId: string,
) =>
	run(
		runtime,
		request.signal,
		requestId,
		Effect.gen(function* () {
			const vouched = yield* vouchedAccess(props);
			if (vouched !== undefined) return vouched;
			const gate = yield* Gate;
			return yield* gate
				.authenticate(request)
				.pipe(
					Effect.catchTag("Unauthorized", (refused) =>
						Effect.flatMap(gate.authorizationServers, (servers) =>
							Effect.fail(
								unauthorized(
									refused.reason,
									servers.length === 0
										? undefined
										: `${new URL(request.url).origin}${RESOURCE_METADATA_PATH}/mcp`,
								),
							),
						),
					),
				);
		}).pipe(Effect.result),
	);

/** The props the Worker's invoker passed, if any. */
const propsOf = (c: Context<AppEnv>): unknown =>
	(c.executionCtx as { readonly props?: unknown }).props;

/** The access a handler's caller holds. Every route that reaches a handler requires one but uploads. */
const accessOf = (caller: Caller) =>
	caller.access === null
		? Effect.die(new Error("A gated operation was reached without access."))
		: Effect.succeed(caller.access);

const spaceOf = (caller: Caller) =>
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		return spaces.of(yield* accessOf(caller));
	});

const tooLarge = (maxBytes: number) =>
	({
		status: 413,
		body: problem("upload.too_large", `Images may be up to ${maxBytes} bytes.`),
	}) as const;

const notFound = (message: string) =>
	Effect.succeed({ status: 404, body: problem("not_found", message) } as const);

/** The handler for each operation the contract declares. */
const handlers = (runtime: WorkerRuntime, request: Request, requestId: string) => {
	const serve = <A>(effect: Effect.Effect<A, never, WorkerServices>) =>
		run(runtime, request.signal, requestId, effect);
	return {
		EventTickets_issue: (caller) =>
			serve(
				Effect.gen(function* () {
					const access = yield* accessOf(caller);
					const spaces = yield* Spaces;
					const issued = yield* spaces.of(access).issueTicket(access.actor.id);
					return {
						status: 201,
						body: { ticket: `${issued.spaceId}.${issued.secret}`, expiresAt: issued.expiresAt },
					} as const;
				}),
			),

		Session_whoami: (caller) =>
			serve(
				Effect.map(
					accessOf(caller),
					(access) =>
						({
							status: 200,
							body: { space: access.space, actor: access.actor },
						}) as const,
				),
			),

		Snapshots_read: (caller) =>
			serve(
				Effect.gen(function* () {
					const space = yield* spaceOf(caller);
					return { status: 200, body: yield* space.snapshot() } as const;
				}),
			),

		Asks_list: (caller, input) =>
			serve(
				Effect.gen(function* () {
					const space = yield* spaceOf(caller);
					return {
						status: 200,
						body: yield* space.history(input.before, input.limit ?? DEFAULT_PAGE),
					} as const;
				}),
			),

		Asks_read: (caller, input) =>
			serve(
				Effect.gen(function* () {
					const space = yield* spaceOf(caller);
					return { status: 200, body: yield* space.get(input.id) } as const;
				}).pipe(Effect.catchTag("AskNotFound", () => notFound(`No ask ${input.id}.`))),
			),

		Asks_reply: (caller, input) =>
			serve(
				Effect.gen(function* () {
					const access = yield* accessOf(caller);
					const space = yield* spaceOf(caller);
					return {
						status: 200,
						body: yield* space.reply(input.id, input.reply, access.actor),
					} as const;
				}).pipe(
					Effect.catchTags({
						AskNotFound: () => notFound(`No ask ${input.id}.`),
						AskClosed: () =>
							Effect.succeed({
								status: 409,
								body: problem("ask.closed", "This ask has already been answered."),
							} as const),
						NotYourTurn: () =>
							Effect.succeed({
								status: 409,
								body: problem("ask.agent_turn", "The agent owes an answer before you can reply."),
							} as const),
						ReplyInvalid: (error) =>
							Effect.succeed({
								status: 422,
								body: problem("reply.invalid", error.reason),
							} as const),
					}),
				),
			),

		Files_read: (caller, input) =>
			serve(
				Effect.gen(function* () {
					const spaces = yield* Spaces;
					const files = yield* Files;
					const access = yield* accessOf(caller);
					const upload = yield* spaces.of(access).findUpload(input.uploadId);
					const body = yield* files.get(fileKey(spaces.idOf(access), input.uploadId));
					if (Option.isNone(body)) return yield* notFound(`No file ${input.uploadId}.`);
					return { status: 200, contentType: upload.contentType, body: body.value } as const;
				}).pipe(Effect.catchTag("UploadNotFound", () => notFound(`No file ${input.uploadId}.`))),
			),

		Uploads_store: (_caller, input) =>
			serve(
				Effect.gen(function* () {
					const spaces = yield* Spaces;
					const files = yield* Files;
					const space = spaces.byId(input.spaceId);
					if (Option.isNone(space)) return yield* notFound("No such upload.");
					const length = Number(request.headers.get("Content-Length") ?? Number.NaN);
					if (!Number.isSafeInteger(length) || length <= 0 || request.body === null) {
						return {
							status: 422,
							body: problem("upload.length_required", "Send the image with a Content-Length."),
						} as const;
					}
					// Refused before the ticket is claimed, so it stays good for an image that fits.
					if (length > UPLOAD_MAX_BYTES) return tooLarge(UPLOAD_MAX_BYTES);
					const claimed = yield* space.value.claimUpload(input.token, input["Content-Type"]);
					if (length > claimed.maxBytes) return tooLarge(claimed.maxBytes);
					yield* files.put(
						fileKey(input.spaceId, claimed.uploadId),
						request.body,
						length,
						claimed.contentType,
					);
					return {
						status: 201,
						body: yield* space.value.completeUpload(claimed.uploadId, length),
					} as const;
				}).pipe(
					Effect.catchTags({
						UploadNotFound: () => notFound("No such upload."),
						UploadExpired: () =>
							Effect.succeed({
								status: 410,
								body: problem("upload.expired", "This upload URL has expired or was already used."),
							} as const),
						UploadRejected: (error) =>
							Effect.succeed({
								status: 422,
								body: problem("upload.rejected", error.reason),
							} as const),
						UploadIncomplete: () =>
							Effect.succeed({
								status: 422,
								body: problem(
									"upload.incomplete",
									"The image ended before, or ran past, its Content-Length.",
								),
							} as const),
					}),
				),
			),
	} satisfies Operations<Caller>;
};

const deps = (runtimeOf: (env: WorkerBindings) => WorkerRuntime): RouteDeps<AppEnv, Caller> => ({
	authorize: (requirements) => async (c, next) => {
		// Every gated operation asks for a bearer token and nothing else; the gate decides what one is.
		if (!requirements.some((requirement) => "BearerAuth" in requirement)) {
			return unauthorized("This operation accepts no credentials Loopback can check.");
		}
		const access = await authenticate(runtimeOf(c.env), c.req.raw, propsOf(c), c.get("requestId"));
		if (access._tag === "Failure") return access.failure;
		c.set("access", access.success);
		await next();
		return undefined;
	},
	context: (c, authentication) => {
		const access = authentication === "none" ? null : (c.get("access") ?? null);
		if (authentication === "required" && access === null) return null;
		return { access, requestId: c.get("requestId"), signal: c.req.raw.signal };
	},
	noContext: () => unauthorized("A bearer token is required."),
	notAcceptable: (c, offered) =>
		c.json(problem("request.not_acceptable", `This responds with ${offered.join(", ")}.`), 406),
	invalid: (result, c) =>
		result.success
			? undefined
			: c.json(problem("request.invalid", "The request does not match the API contract."), 400),
});

/**
 * The Worker's surface: the contract's routes, the event socket, the document that describes them,
 * and the MCP endpoint agents connect to.
 */
export const makeApp = (runtimeOf: (env: WorkerBindings) => WorkerRuntime) => {
	const app = new Hono<AppEnv>({ router: new RegExpRouter() });

	// Middleware before `registerRoutes`: Hono applies it only to routes registered after it.
	app.use(async (c, next) => {
		c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
		await next();
	});
	// Nothing the Worker answers is to be sniffed as another type. A WebSocket's 101 is the space's
	// own response, and is left as it is.
	app.use(async (c, next) => {
		await next();
		if (c.res.status === 101) return;
		c.res.headers.set("X-Content-Type-Options", "nosniff");
		c.res.headers.set("Referrer-Policy", "no-referrer");
	});
	app.onError((error, c) => answerUnhandled(error, c.get("requestId")));
	app.notFound((c) => c.json(problem("not_found", "No such route."), 404));

	app.get("/api/v1/openapi.json", (c) => c.json(document));

	// Protected resource metadata for the MCP endpoint, when the gate takes credentials from an
	// authorization server: clients find it at the well-known path or under it, by the resource's path.
	const protectedResource = async (c: Context<AppEnv>) => {
		const servers = await run(
			runtimeOf(c.env),
			c.req.raw.signal,
			c.get("requestId"),
			Gate.use((gate) => gate.authorizationServers),
		);
		if (servers.length === 0) return c.json(problem("not_found", "No such route."), 404);
		return c.json({
			resource: `${new URL(c.req.url).origin}/mcp`,
			authorization_servers: servers,
			bearer_methods_supported: ["header"],
			resource_name: "Loopback",
		});
	};
	app.get(RESOURCE_METADATA_PATH, protectedResource);
	app.get(`${RESOURCE_METADATA_PATH}/mcp`, protectedResource);

	app.get("/api/v1/events", async (c) => {
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
			return c.json(problem("events.upgrade_required", "Connect with a WebSocket."), 426);
		}
		const runtime = runtimeOf(c.env);
		const ticket = ticketOf(c.req.raw);
		if (ticket !== undefined) {
			// A browser's one-time pass, spent against the space it names.
			return run(
				runtime,
				c.req.raw.signal,
				c.get("requestId"),
				Effect.gen(function* () {
					const spaces = yield* Spaces;
					const space = spaces.byId(ticket.spaceId);
					if (Option.isNone(space)) return unauthorized("The event ticket is not valid.");
					yield* space.value.redeemTicket(ticket.secret);
					return yield* spaces.connect(ticket.spaceId, c.req.raw);
				}).pipe(
					Effect.catchTag("TicketInvalid", () =>
						Effect.succeed(unauthorized("The event ticket is not valid, or was already used.")),
					),
				),
			);
		}
		const access = await authenticate(runtime, c.req.raw, propsOf(c), c.get("requestId"));
		if (access._tag === "Failure") return access.failure;
		return run(
			runtime,
			c.req.raw.signal,
			c.get("requestId"),
			Spaces.use((spaces) => spaces.connect(access.success, c.req.raw)),
		);
	});

	const mcp = makeMcp();
	app.all("/mcp", async (c) => {
		const runtime = runtimeOf(c.env);
		const access = await authenticate(runtime, c.req.raw, propsOf(c), c.get("requestId"));
		if (access._tag === "Failure") return access.failure;
		return mcp(c.req.raw, runtime, access.success, c.get("requestId"));
	});

	return registerRoutes(
		app,
		(c) => handlers(runtimeOf(c.env), c.req.raw, c.get("requestId")),
		deps(runtimeOf),
	);
};
