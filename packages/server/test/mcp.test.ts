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
			"answer_briefing",
			"answer_follow_up",
			"ask_question",
			"create_image_upload",
			"open_inbox",
			"request_review",
			"send_briefing",
		]);
		const ask = tools.find((tool) => tool.name === "ask_question");
		expect(ask?.inputSchema.required?.toSorted()).toEqual(["project", "question"]);
		expect(ask?.outputSchema).toBeUndefined();
		expect(client.getInstructions()).toContain("ask_question");
		expect(client.getInstructions()).toContain("send_briefing");
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

	// Both eras share one space, and a briefing can be left with the agent: each era names its own.
	const migration = (title: string) => ({
		title: `${title} (${mode})`,
		sections: [
			{
				title: "Storage",
				points: [{ title: "Sessions move to D1" }, { title: "R2 keeps images" }],
			},
			{ points: [{ title: "Tokens are hashed at rest" }] },
		],
		project: "mcp-test",
	});

	const briefing = (title: string) =>
		opened((open) => open.kind === "briefing" && open.prompt.title === `${title} (${mode})`);

	it("runs a briefing through sub-points to its close", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Run it through") });
		const ask = await briefing("Run it through");
		await reply(ask.id, {
			outcome: "responded",
			points: [
				{ point: "1", text: "Why D1?" },
				{ point: "2", resolved: true },
			],
		});
		const first = await sent;
		expect(first.isError).toBeFalsy();
		expect(first.structuredContent).toMatchObject({
			askId: ask.id,
			reply: { outcome: "responded" },
		});
		expect(textOf(first)).toContain('Point 1 (Sessions move to D1): they wrote "Why D1?"');
		expect(textOf(first)).toContain("Point 2 (R2 keeps images): resolved.");

		const answered = client.callTool({
			name: "answer_briefing",
			arguments: {
				askId: ask.id,
				answers: [
					{
						point: "1",
						answer: "Two reasons.",
						points: [{ title: "Queries across sessions" }, { title: "One less binding" }],
					},
				],
			},
		});
		await opened((open) => open.id === ask.id && open.status === "awaiting_human");
		await reply(ask.id, {
			outcome: "responded",
			points: [{ point: "1.2", text: "Which binding?" }],
		});
		const second = await answered;
		expect(textOf(second)).toContain('Point 1.2 (One less binding): they wrote "Which binding?"');

		const closing = client.callTool({
			name: "answer_briefing",
			arguments: { askId: ask.id, answers: [{ point: "1.2", answer: "SESSIONS, in KV." }] },
		});
		await opened(
			(open) => open.id === ask.id && open.status === "awaiting_human" && open.thread.length === 4,
		);
		await reply(ask.id, {
			outcome: "responded",
			points: [
				{ point: "1", resolved: true },
				{ point: "3", text: "Fine.", resolved: true },
			],
		});
		const closed = await closing;
		expect(textOf(closed)).toContain(
			'Point 3 (Tokens are hashed at rest): resolved, saying "Fine."',
		);
		expect(textOf(closed)).toContain("The briefing is closed");
		expect(textOf(closed)).not.toContain("answer_briefing");
		await client.close();
	});

	it("names what the agent owes, by id and title", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Owed") });
		const ask = await briefing("Owed");
		await reply(ask.id, {
			outcome: "responded",
			points: [
				{ point: "3", text: "Which hash?" },
				{ point: "2", text: "Which bucket?" },
			],
		});
		const text = textOf(await sent);
		expect(text).toContain(
			`Answer points 2 (R2 keeps images) and 3 (Tokens are hashed at rest) with answer_briefing (askId: "${ask.id}")`,
		);
		await client.close();
	});

	it("refuses answer_briefing that misses an owed point, and after the person dismissed it", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Refusals") });
		const ask = await briefing("Refusals");
		await reply(ask.id, { outcome: "responded", points: [{ point: "1", text: "Why?" }] });
		await sent;
		const missing = await client.callTool({
			name: "answer_briefing",
			arguments: { askId: ask.id, answers: [{ point: "2", answer: "Unasked." }] },
		});
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toBe("Answer every point the person wrote on: 1 is missing.");
		await reply(ask.id, { outcome: "dismissed" });
		const late = await client.callTool({
			name: "answer_briefing",
			arguments: { askId: ask.id, answers: [{ point: "1", answer: "Because." }] },
		});
		expect(late.isError).toBe(true);
		expect(textOf(late)).toContain("closed that briefing");
		await client.close();
	});

	it("refuses answers on a resolved, unknown or repeated point, and sub-points past three levels", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Bad answers") });
		const ask = await briefing("Bad answers");
		await reply(ask.id, {
			outcome: "responded",
			points: [
				{ point: "1", text: "Why?" },
				{ point: "2", resolved: true },
			],
		});
		await sent;
		const refusal = async (answers: unknown) => {
			const result = await client.callTool({
				name: "answer_briefing",
				arguments: { askId: ask.id, answers },
			});
			expect(result.isError).toBe(true);
			return textOf(result);
		};
		expect(
			await refusal([
				{ point: "1", answer: "Because." },
				{ point: "2", answer: "More." },
			]),
		).toBe("Point 2 is resolved: the person is done with it.");
		expect(await refusal([{ point: "9", answer: "?" }])).toBe('No point "9".');
		expect(
			await refusal([
				{ point: "1", answer: "a" },
				{ point: "1", answer: "b" },
			]),
		).toBe("Point 1 appears twice.");

		// Down to 1.1.1, the deepest a point goes.
		let id = "1";
		for (const depth of [2, 3]) {
			const move = client.callTool({
				name: "answer_briefing",
				arguments: {
					askId: ask.id,
					answers: [{ point: id, answer: "Deeper.", points: [{ title: `Level ${depth}` }] }],
				},
			});
			id = `${id}.1`;
			await opened((open) => open.id === ask.id && open.status === "awaiting_human");
			await reply(ask.id, { outcome: "responded", points: [{ point: id, text: "And?" }] });
			await move;
		}
		expect(await refusal([{ point: "1.1.1", answer: "No.", points: [{ title: "Level 4" }] }])).toBe(
			"Point 1.1.1 is as deep as points go: answer it without sub-points.",
		);
		await reply(ask.id, { outcome: "dismissed" });
		await client.close();
	});

	it("refuses over REST a reply that leaves the agent nothing, and responded on a question", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Bad replies") });
		const ask = await briefing("Bad replies");
		const idle = await reply(ask.id, {
			outcome: "responded",
			points: [{ point: "2", resolved: true }],
		});
		expect(idle.status).toBe(422);
		expect(await idle.text()).toContain("1 and 3 are still open");
		await reply(ask.id, { outcome: "dismissed" });
		await sent;

		const question = client.callTool({
			name: "ask_question",
			arguments: { question: `Points on a question (${mode})?`, project: "mcp-test" },
		});
		const asked = await opened(
			(open) =>
				open.kind === "question" && open.prompt.question === `Points on a question (${mode})?`,
		);
		const wrong = await reply(asked.id, {
			outcome: "responded",
			points: [{ point: "1", text: "?" }],
		});
		expect(wrong.status).toBe(422);
		await reply(asked.id, { outcome: "dismissed" });
		await question;
		await client.close();
	});

	it("rejoins a retried send_briefing, keeping the reply given while it was cut off", async () => {
		const input = migration("Cut off");
		const gone = await connect();
		gone.callTool({ name: "send_briefing", arguments: input }).catch(() => {});
		const ask = await briefing("Cut off");
		await pause(300);
		await gone.close();
		await pause(300);
		await reply(ask.id, { outcome: "responded", points: [{ point: "3", text: "Salted?" }] });
		await pause(500);
		const back = await connect();
		const retried = await back.callTool({ name: "send_briefing", arguments: input });
		expect(retried.structuredContent).toMatchObject({
			askId: ask.id,
			reply: { outcome: "responded" },
		});
		const snapshot = await Effect.runPromise(space.snapshot());
		expect(
			[...snapshot.open, ...snapshot.recent].filter(
				(open) => open.kind === "briefing" && open.prompt.title === input.title,
			),
		).toHaveLength(1);
		await reply(ask.id, { outcome: "dismissed" });
		await back.close();
	});

	it("rejoins a retried answer_briefing cut off while waiting, with the reply given meanwhile", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Answer cut off") });
		const ask = await briefing("Answer cut off");
		await reply(ask.id, { outcome: "responded", points: [{ point: "1", text: "Why?" }] });
		await sent;
		await client.close();
		const move = {
			askId: ask.id,
			answers: [{ point: "1", answer: "Queries.", points: [{ title: "Counting" }] }],
		};
		const gone = await connect();
		gone.callTool({ name: "answer_briefing", arguments: move }).catch(() => {});
		await opened((open) => open.id === ask.id && open.status === "awaiting_human");
		await pause(300);
		await gone.close();
		await pause(300);
		await reply(ask.id, { outcome: "responded", points: [{ point: "1.1", text: "Which?" }] });
		await pause(500);
		const back = await connect();
		const retried = await back.callTool({ name: "answer_briefing", arguments: move });
		expect(retried.structuredContent).toMatchObject({
			askId: ask.id,
			reply: { outcome: "responded", points: [{ point: "1.1", text: "Which?" }] },
		});
		expect((await Effect.runPromise(space.get(ask.id))).thread).toHaveLength(3);
		await reply(ask.id, { outcome: "dismissed" });
		await back.close();
	});

	it("names words beneath a point resolved in the same reply as closing notes", async () => {
		const client = await connect();
		const sent = client.callTool({ name: "send_briefing", arguments: migration("Notes beneath") });
		const ask = await briefing("Notes beneath");
		await reply(ask.id, { outcome: "responded", points: [{ point: "1", text: "Why?" }] });
		await sent;
		const answered = client.callTool({
			name: "answer_briefing",
			arguments: {
				askId: ask.id,
				answers: [{ point: "1", answer: "Queries.", points: [{ title: "Counting" }] }],
			},
		});
		await opened((open) => open.id === ask.id && open.status === "awaiting_human");
		await reply(ask.id, {
			outcome: "responded",
			points: [
				{ point: "1.1", text: "Noted." },
				{ point: "1", resolved: true },
				{ point: "2", text: "And?" },
			],
		});
		const text = textOf(await answered);
		expect(text).toContain('Point 1.1 (Counting): resolved, saying "Noted."');
		expect(text).toContain("Answer point 2 (R2 keeps images) with answer_briefing");
		await reply(ask.id, { outcome: "dismissed" });
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
