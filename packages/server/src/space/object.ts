import { SqliteClient } from "@effect/sql-sqlite-do";
import type { ServerEvent } from "@loopbackhq/protocol";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { migrations } from "./migrations.ts";
import { operations, snapshot } from "./operations.ts";
import { encodeExit, type ExitJson, type OperationName, type SpaceFailure } from "./rpc.ts";
import { Host, Presence, Replies } from "./services.ts";
import { AskStore, TicketStore, UploadStore } from "./store.ts";

/** The subprotocol an inbox speaks on the event socket. */
export const EVENTS_PROTOCOL = "loopback.v1";

type SpaceServices = AskStore | UploadStore | TicketStore | Host | Replies | Presence;

/**
 * One space: its asks, their threads, upload tickets, and the inboxes watching it. Everything it
 * does is a space operation, served through `call`; `fetch` only accepts an inbox's WebSocket.
 */
export class Space extends DurableObject {
	#runtime: ManagedRuntime.ManagedRuntime<SpaceServices, never>;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env as never);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.#runtime = this.#build();
		// Build the runtime, migrations included, before the object takes any request.
		void ctx.blockConcurrencyWhile(() => this.#runtime.runPromise(Effect.void));
	}

	#build(): ManagedRuntime.ManagedRuntime<SpaceServices, never> {
		const sql = SqliteClient.layer({ storage: this.ctx.storage });
		const host = Layer.succeed(
			Host,
			Host.of({
				broadcast: (event) => this.#broadcast(event),
				spaceId: this.ctx.id.toString(),
			}),
		);
		return ManagedRuntime.make(
			Layer.mergeAll(AskStore.layer, UploadStore.layer, TicketStore.layer, migrations).pipe(
				Layer.provide(sql),
				Layer.merge(Layer.mergeAll(host, Replies.layer, Presence.layer)),
				Layer.merge(Logger.layer([Logger.consoleJson])),
				Layer.orDie,
			),
		);
	}

	/**
	 * Deletes everything the space holds and closes the inboxes watching it. It carries on as an
	 * empty space: its schema is applied afresh before it takes another request. An agent waiting
	 * on an ask it held finds the ask gone at the end of its current lap.
	 */
	async erase(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.close(1000, "The space was erased.");
				} catch {
					// Already closing.
				}
			}
			const erased = this.#runtime;
			await this.ctx.storage.deleteAll();
			this.#runtime = this.#build();
			await this.#runtime.runPromise(Effect.void);
			await erased.dispose();
		});
	}

	/** Runs one space operation and answers with its Exit, encoded for the trip back. */
	async call(method: OperationName, args: readonly unknown[]): Promise<ExitJson> {
		if (!Object.hasOwn(operations, method)) {
			return encodeExit(
				await Effect.runPromiseExit(Effect.die(new Error(`No operation ${method}`))),
			);
		}
		const operation = operations[method] as (
			...args: readonly unknown[]
		) => Effect.Effect<unknown, SpaceFailure, SpaceServices>;
		return encodeExit(await this.#runtime.runPromiseExit(operation(...args)));
	}

	/** Accepts an inbox's event socket and sends it the space as it stands. */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		}
		// Read the space first: a socket is only accepted once there is something to send it.
		const current = await this.#runtime.runPromise(snapshot);
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const first: ServerEvent = { type: "snapshot", snapshot: current };
		server.send(JSON.stringify(first));
		const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
			.split(",")
			.map((protocol) => protocol.trim());
		return new Response(null, {
			status: 101,
			webSocket: client,
			...(offered.includes(EVENTS_PROTOCOL)
				? { headers: { "Sec-WebSocket-Protocol": EVENTS_PROTOCOL } }
				: {}),
		});
	}

	/**
	 * Inboxes only send keep-alive pings, which the auto-response answers without waking us. Closing
	 * needs no handler: the runtime completes the close handshake itself.
	 */
	override async webSocketMessage(): Promise<void> {}

	#broadcast(event: ServerEvent): Effect.Effect<void> {
		return Effect.sync(() => {
			const frame = JSON.stringify(event);
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.send(frame);
				} catch {
					// A socket that is closing misses the frame; it gets a fresh snapshot on reconnect.
				}
			}
		});
	}
}
