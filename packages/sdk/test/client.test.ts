import type { Ask, ServerEvent } from "@loopbackhq/protocol";
import { describe, expect, it } from "vitest";
import { ApiError, createLoopbackClient, type InboxState } from "../src/index.ts";

const ask: Ask = {
	kind: "question",
	prompt: { question: "Tabs or spaces?", options: [{ label: "Tabs" }], multiple: false },
	id: "ask-1",
	status: "awaiting_human",
	waiting: true,
	thread: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A WebSocket the test drives by hand. */
class FakeSocket extends EventTarget {
	static readonly OPEN = 1;
	static readonly opened: FakeSocket[] = [];
	readonly url: string;
	readonly protocols: string[];
	readyState = FakeSocket.OPEN;
	readonly sent: string[] = [];
	closed = false;

	constructor(url: string, protocols: string[]) {
		super();
		this.url = url;
		this.protocols = protocols;
		FakeSocket.opened.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.closed = true;
	}

	receive(frame: ServerEvent) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}

	drop() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}

const recording = (responses: Record<string, () => Response>) => {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, init });
		const path = new URL(url).pathname;
		const respond = responses[`${init?.method ?? "GET"} ${path}`];
		return respond === undefined ? new Response("{}", { status: 404 }) : respond();
	};
	return { calls, fetch: fetch as typeof globalThis.fetch };
};

const until = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition never held");
};

describe("the client", () => {
	it("sends the token and the reply", async () => {
		const { calls, fetch } = recording({
			[`POST /api/v1/asks/ask-1/reply`]: () => Response.json({ ...ask, status: "closed" }),
		});
		const client = createLoopbackClient({ baseUrl: "https://lb.test/", token: "secret", fetch });
		const closed = await client.reply("ask-1", { outcome: "answered", selected: ["Tabs"] });
		expect(closed.status).toBe("closed");
		expect(calls[0]?.url).toBe("https://lb.test/api/v1/asks/ask-1/reply");
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer secret");
		expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
			outcome: "answered",
			selected: ["Tabs"],
		});
	});

	it("rejects with the server's problem as an ApiError", async () => {
		const { fetch } = recording({
			[`POST /api/v1/asks/ask-1/reply`]: () =>
				Response.json({ code: "ask.closed", message: "Already answered." }, { status: 409 }),
		});
		const client = createLoopbackClient({
			baseUrl: "https://lb.test",
			token: async () => "fresh",
			fetch,
		});
		const error = await client
			.reply("ask-1", { outcome: "dismissed" })
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, code: "ask.closed", message: "Already answered." });
	});

	it("follows the inbox live, and reconnects when the socket drops", async () => {
		FakeSocket.opened.length = 0;
		let issued = 0;
		const { calls, fetch } = recording({
			[`POST /api/v1/events/tickets`]: () => {
				issued += 1;
				return Response.json(
					{ ticket: `space.pass${issued}`, expiresAt: "2026-01-01T00:01:00.000Z" },
					{ status: 201 },
				);
			},
		});
		const client = createLoopbackClient({
			baseUrl: "https://lb.test",
			token: "secret",
			fetch,
			WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
		});
		const states: InboxState[] = [];
		const stop = client.inbox.subscribe(() => states.push(client.inbox.getSnapshot()));
		await until(() => FakeSocket.opened.length === 1);
		const first = FakeSocket.opened[0];
		expect(first?.url).toBe("wss://lb.test/api/v1/events");
		// The socket opens with a one-time ticket; the token goes only in a header.
		expect(first?.protocols).toEqual(["loopback.v1", "loopback.ticket.space.pass1"]);
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer secret");

		first?.receive({ type: "snapshot", snapshot: { open: [], recent: [] } });
		first?.receive({ type: "ask.opened", ask });
		await until(() => client.inbox.getSnapshot().open.length === 1);
		expect(client.inbox.getSnapshot().status).toBe("live");

		first?.drop();
		await until(() => client.inbox.getSnapshot().status === "reconnecting");
		await until(() => FakeSocket.opened.length === 2);
		expect(FakeSocket.opened[1]?.protocols).toEqual(["loopback.v1", "loopback.ticket.space.pass2"]);
		FakeSocket.opened[1]?.receive({ type: "snapshot", snapshot: { open: [], recent: [ask] } });
		await until(() => client.inbox.getSnapshot().recent.length === 1);
		expect(client.inbox.getSnapshot()).toMatchObject({ status: "live", open: [] });

		stop();
		await until(() => FakeSocket.opened[1]?.closed === true);
		expect(states.length).toBeGreaterThan(3);
	});
});
