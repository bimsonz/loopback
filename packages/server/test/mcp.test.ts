import type { Ask, ToolReply, UploadTicket } from "@loopbackhq/protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "@effect/vitest";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { DEFAULT_SPACE } from "../src/index.ts";
import { spaceClient } from "../src/space/rpc.ts";

const ORIGIN = "https://loopback.test";
const stub = () => exports.Space.get(exports.Space.idFromName(DEFAULT_SPACE));
const space = spaceClient(stub);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Era = "legacy" | "auto";

const connectWith = async (mode: Era, token: string = env.LOOPBACK_TOKEN) => {
	const client = new Client(
		{ name: "loopback-test", version: "1.0.0" },
		{ versionNegotiation: { mode } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			fetch: (url, init) => exports.default.fetch(url, init),
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return client;
};

/** The open ask matching `test`, once it appears. */
const opened = async (test: (ask: Ask) => boolean): Promise<Ask> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const snapshot = await Effect.runPromise(space.snapshot());
		const found = snapshot.open.find(test);
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("The ask never opened.");
};

const reply = (askId: string, body: unknown) =>
	exports.default.fetch(`${ORIGIN}/api/v1/asks/${askId}/reply`, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { Authorization: `Bearer ${env.LOOPBACK_TOKEN}`, "Content-Type": "application/json" },
	});

const textOf = (result: { content?: unknown }) =>
	Array.isArray(result.content)
		? result.content.map((part: { text?: string }) => part.text ?? "").join("\n")
		: "";

// Clients speak either protocol era: the 2025 handshake, or 2026-07-28 with a per-request envelope.
describe.each<Era>(["legacy", "auto"])("the MCP endpoint (%s negotiation)", (mode) => {
	const connect = (token?: string) => connectWith(mode, token);

	it("refuses a client without the token", async () => {
		const response = await exports.default.fetch(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
		expect(response.status).toBe(401);
		await expect(connect("wrong")).rejects.toThrow();
	});

	it("offers its tools and says when to use them", async () => {
		const client = await connect();
		expect(client.getServerVersion()).toMatchObject({
			name: "loopback",
			version: packageJson.version,
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).toSorted()).toEqual([
			"answer_follow_up",
			"ask_question",
			"create_image_upload",
			"open_inbox",
			"request_review",
		]);
		const ask = tools.find((tool) => tool.name === "ask_question");
		expect(ask?.inputSchema.required?.toSorted()).toEqual(["project", "question"]);
		expect(ask?.outputSchema).toBeUndefined();
		expect(client.getInstructions()).toContain("ask_question");
		await client.close();
	});

	it("blocks ask_question until the person answers, reporting progress meanwhile", async () => {
		const client = await connect();
		const progress: number[] = [];
		const call = client.callTool(
			{
				name: "ask_question",
				arguments: {
					question: "Which database?",
					options: [{ label: "D1" }, { label: "Durable Object SQLite" }],
					project: "mcp-test",
				},
			},
			{ onprogress: (update) => progress.push(update.progress) },
		);
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === "Which database?",
		);
		expect(ask.project).toBe("mcp-test");
		// Only the 2026-07-28 envelope names the client on every request.
		expect(ask.client).toBe(mode === "auto" ? "loopback-test 1.0.0" : undefined);
		expect(
			(await reply(ask.id, { outcome: "answered", selected: ["D1"], text: "Keep it simple" }))
				.status,
		).toBe(200);
		const result = await call;
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			askId: ask.id,
			reply: { outcome: "answered", selected: ["D1"], text: "Keep it simple" },
		} satisfies ToolReply);
		expect(textOf(result)).toContain('They chose: "D1".');
		expect(progress.length).toBeGreaterThan(0);
		await client.close();
	});

	it("runs a review through a follow-up to approval", async () => {
		const client = await connect();
		const review = client.callTool({
			name: "request_review",
			arguments: {
				title: "Release notes",
				content: [{ type: "markdown", text: "Loopback 0.1 is out." }],
				project: "mcp-test",
			},
		});
		const ask = await opened(
			(open) => open.kind === "review" && open.prompt.title === "Release notes",
		);
		await reply(ask.id, { outcome: "follow_up", question: "Is 0.1 the right number?" });
		const followUp = await review;
		expect(followUp.structuredContent).toMatchObject({ reply: { outcome: "follow_up" } });
		expect(textOf(followUp)).toContain("answer_follow_up");

		const answer = client.callTool({
			name: "answer_follow_up",
			arguments: { askId: ask.id, answer: "Yes: it is the first release." },
		});
		await opened((open) => open.id === ask.id && open.status === "awaiting_human");
		await reply(ask.id, { outcome: "approved", note: "Ship it" });
		const decision = await answer;
		expect(decision.structuredContent).toEqual({
			askId: ask.id,
			reply: { outcome: "approved", note: "Ship it" },
		});
		expect(textOf(decision)).toBe("Approved, with a note: Ship it");
		await client.close();
	});

	it("tells the agent how to revise after changes are requested", async () => {
		const client = await connect();
		const review = client.callTool({
			name: "request_review",
			arguments: {
				title: "Tagline",
				content: [{ type: "markdown", text: "Ask anything." }],
				project: "mcp-test",
			},
		});
		const ask = await opened((open) => open.kind === "review" && open.prompt.title === "Tagline");
		await reply(ask.id, { outcome: "changes_requested", feedback: "Warmer, please." });
		expect(textOf(await review)).toContain(`revises: "${ask.id}"`);
		await client.close();
	});

	it("gives the address of the inbox, or of one ask in it", async () => {
		const client = await connect();
		const inbox = await client.callTool({ name: "open_inbox", arguments: {} });
		expect(inbox.structuredContent).toEqual({ url: `${ORIGIN}/` });
		const one = await client.callTool({ name: "open_inbox", arguments: { askId: "a b" } });
		expect(one.structuredContent).toEqual({ url: `${ORIGIN}/#/a%20b` });
		expect(textOf(one)).toContain(`${ORIGIN}/#/a%20b`);
		await client.close();
	});

	it("refuses an ask that does not name its project", async () => {
		const client = await connect();
		const refused = await client
			.callTool({ name: "ask_question", arguments: { question: "Who am I?" } })
			.then(
				(result) => result.isError === true,
				() => true,
			);
		expect(refused).toBe(true);
		await client.close();
	});

	it("refuses answer_follow_up when nothing was asked back", async () => {
		const client = await connect();
		const result = await client.callTool({
			name: "answer_follow_up",
			arguments: { askId: "missing", answer: "Hello?" },
		});
		expect(result.isError).toBe(true);
		await client.close();
	});

	it("uploads an image and shows it in a review", async () => {
		const client = await connect();
		const issued = await client.callTool({
			name: "create_image_upload",
			arguments: { contentType: "image/png" },
		});
		const ticket = issued.structuredContent as UploadTicket;
		expect(ticket.uploadUrl.startsWith(`${ORIGIN}/api/v1/uploads/`)).toBe(true);
		expect(ticket.command).toContain(ticket.uploadUrl);
		const stored = await exports.default.fetch(ticket.uploadUrl, {
			method: "PUT",
			body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			headers: { "Content-Type": "image/png" },
		});
		expect(stored.status).toBe(201);

		const missing = await client.callTool({
			name: "request_review",
			arguments: {
				title: "Missing",
				content: [{ type: "image", uploadId: "nope" }],
				project: "mcp-test",
			},
		});
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("create_image_upload");

		const review = client.callTool({
			name: "request_review",
			arguments: {
				title: "Screenshot",
				content: [{ type: "image", uploadId: ticket.uploadId }],
				project: "mcp-test",
			},
		});
		const ask = await opened(
			(open) => open.kind === "review" && open.prompt.title === "Screenshot",
		);
		await reply(ask.id, { outcome: "dismissed" });
		expect((await review).structuredContent).toMatchObject({ reply: { outcome: "dismissed" } });
		await client.close();
	});

	it("leaves the ask open when the agent stops waiting", async () => {
		const client = await connect();
		const stop = new AbortController();
		const call = client.callTool(
			{ name: "ask_question", arguments: { question: "Abandon me?", project: "mcp-test" } },
			{ signal: stop.signal },
		);
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === "Abandon me?",
		);
		stop.abort();
		await expect(call).rejects.toThrow();
		expect((await Effect.runPromise(space.get(ask.id))).status).toBe("awaiting_human");
		await client.close();
	});

	it("keeps a reply given while the agent's wait was cut off, for its retry", async () => {
		const input = { question: `Still there (${mode})?`, project: "mcp-test" };
		const gone = await connect();
		gone.callTool({ name: "ask_question", arguments: input }).catch(() => {});
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === input.question,
		);
		// The agent's connection drops partway through a wait, and the person answers after.
		await pause(300);
		await gone.close();
		await pause(300);
		await reply(ask.id, { outcome: "answered", selected: [], text: "Yes" });
		await pause(500);
		const back = await connect();
		const retried = await back.callTool({ name: "ask_question", arguments: input });
		expect(retried.structuredContent).toEqual({
			askId: ask.id,
			reply: { outcome: "answered", selected: [], text: "Yes" },
		});
		await back.close();
	});

	it("loses nothing when a restart of its space cuts a wait short", async () => {
		const client = await connect();
		const input = { question: `Through a restart (${mode})?`, project: "mcp-test" };
		const call = client.callTool({ name: "ask_question", arguments: input });
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === input.question,
		);
		await pause(300);
		// In-memory state gone and in-flight calls refused, without the retryable mark a deploy's
		// reset carries: the wait ends, and says only what to quote.
		await abortAllDurableObjects();
		const cut = await call;
		expect(cut.isError).toBe(true);
		expect(textOf(cut)).toMatch(/^Something went wrong in Loopback\. Incident \S+\.$/);
		await reply(ask.id, { outcome: "answered", selected: [], text: "Made it" });
		const retried = await client.callTool({ name: "ask_question", arguments: input });
		expect(retried.structuredContent).toEqual({
			askId: ask.id,
			reply: { outcome: "answered", selected: [], text: "Made it" },
		});
		await client.close();
	});

	it("tells the agent an incident to quote, not Loopback's internals, when a tool breaks", async () => {
		const client = await connect();
		const rename = (from: string, to: string) =>
			runInDurableObject(stub(), (_object, state) => {
				state.storage.sql.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
			});
		await rename("uploads", "uploads_away");
		try {
			const result = await client.callTool({
				name: "create_image_upload",
				arguments: { contentType: "image/png" },
			});
			expect(result.isError).toBe(true);
			expect(textOf(result)).toMatch(/^Something went wrong in Loopback\. Incident \S+\.$/);
		} finally {
			await rename("uploads_away", "uploads");
			await client.close();
		}
	});
});
