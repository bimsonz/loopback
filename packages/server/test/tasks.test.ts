import type { Ask } from "@loopbackhq/protocol";
import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { DEFAULT_SPACE } from "../src/index.ts";
import { spaceClient } from "../src/space/rpc.ts";

const ORIGIN = "https://loopback.test";
const TASKS = "io.modelcontextprotocol/tasks";
const space = spaceClient(() => exports.Space.get(exports.Space.idFromName(DEFAULT_SPACE)));

interface Message {
	readonly id?: number;
	readonly result?: Record<string, unknown> & {
		readonly resultType?: string;
		readonly taskId?: string;
		readonly status?: string;
		readonly result?: { readonly structuredContent?: unknown; readonly content?: unknown };
	};
	readonly error?: { readonly code: number; readonly message: string };
}

let nextId = 1;

/** One 2026-07-28 request, as a client that does (or does not) follow background tasks sends it. */
const rpc = async (
	method: string,
	params: Record<string, unknown>,
	options: { readonly name?: string; readonly tasks?: boolean } = {},
): Promise<Message> => {
	const id = nextId++;
	const response = await exports.default.fetch(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.LOOPBACK_TOKEN}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": method,
			...(options.name === undefined ? {} : { "Mcp-Name": options.name }),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "tasks-test", version: "1.0.0" },
					"io.modelcontextprotocol/clientCapabilities":
						options.tasks === false ? {} : { extensions: { [TASKS]: {} } },
				},
			},
		}),
	});
	const body = await response.text();
	const frames = body.startsWith("{")
		? [body]
		: body
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim());
	const message = frames
		.map((frame) => JSON.parse(frame) as Message)
		.find((frame) => frame.id === id);
	if (message === undefined)
		throw new Error(`No response to ${method}: ${response.status} ${body}`);
	return message;
};

const call = (name: string, args: Record<string, unknown>, tasks = true) =>
	rpc(
		"tools/call",
		{ name, arguments: name === "answer_follow_up" ? args : { project: "tasks-test", ...args } },
		{ name, tasks },
	);

const poll = (taskId: string, tasks = true) =>
	rpc("tasks/get", { taskId }, { name: taskId, tasks });

const reply = (askId: string, body: unknown) =>
	exports.default.fetch(`${ORIGIN}/api/v1/asks/${askId}/reply`, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { Authorization: `Bearer ${env.LOOPBACK_TOKEN}`, "Content-Type": "application/json" },
	});

const askOf = (taskId: string) => taskId.slice(0, taskId.lastIndexOf(":"));

const read = (askId: string): Promise<Ask> => Effect.runPromise(space.get(askId));

describe("background tasks", () => {
	it("advertises the extension", async () => {
		const discovered = await rpc("server/discover", {});
		expect(discovered.result).toMatchObject({ capabilities: { extensions: { [TASKS]: {} } } });
	});

	it("return a working task at once, and complete it with the reply", async () => {
		const started = await call("ask_question", {
			question: "Background or blocking?",
			options: [{ label: "Background" }, { label: "Blocking" }],
			project: "tasks-test",
		});
		expect(started.result).toMatchObject({
			resultType: "task",
			status: "working",
			ttlMs: null,
			pollIntervalMs: 2000,
		});
		const taskId = started.result?.taskId ?? "";
		const askId = askOf(taskId);
		expect(taskId).toBe(`${askId}:0`);
		expect((await read(askId)).status).toBe("awaiting_human");

		expect((await poll(taskId)).result).toMatchObject({
			resultType: "complete",
			status: "working",
		});
		expect((await read(askId)).waiting).toBe(true);

		await reply(askId, { outcome: "answered", selected: ["Background"] });
		const done = await poll(taskId);
		expect(done.result).toMatchObject({ status: "completed" });
		expect(done.result?.result?.structuredContent).toEqual({
			askId,
			reply: { outcome: "answered", selected: ["Background"] },
		});
		expect(JSON.stringify(done.result?.result?.content)).toContain('They chose: \\"Background\\".');
		expect((await poll(taskId)).result).toMatchObject({ status: "completed" });
	});

	it("ask to be polled less often the longer they wait", async () => {
		const started = await call("ask_question", {
			question: "Polled slowly?",
			project: "tasks-test",
		});
		const taskId = started.result?.taskId ?? "";
		const askId = askOf(taskId);
		const age = (minutes: number) =>
			runInDurableObject(
				exports.Space.get(exports.Space.idFromName(DEFAULT_SPACE)),
				(_object, state) => {
					const at = new Date(Date.now() - minutes * 60_000).toISOString();
					state.storage.sql.exec("UPDATE asks SET created_at = ? WHERE id = ?", at, askId);
				},
			);
		expect((await poll(taskId)).result?.pollIntervalMs).toBe(2_000);
		await age(5);
		expect((await poll(taskId)).result?.pollIntervalMs).toBe(10_000);
		await age(45);
		expect((await poll(taskId)).result?.pollIntervalMs).toBe(30_000);
		await reply(askId, { outcome: "dismissed" });
	});

	it("can be stacked, and each completes on its own reply", async () => {
		const first = await call("ask_question", { question: "Stack one?" });
		const second = await call("request_review", {
			title: "Stack two",
			content: [{ type: "markdown", text: "Two." }],
		});
		const one = first.result?.taskId ?? "";
		const two = second.result?.taskId ?? "";
		expect(one).not.toBe(two);
		await reply(askOf(two), { outcome: "approved" });
		expect((await poll(two)).result).toMatchObject({ status: "completed" });
		expect((await poll(one)).result).toMatchObject({ status: "working" });
	});

	it("carry a follow-up through to the decision", async () => {
		const started = await call("request_review", {
			title: "Follow me up",
			content: [{ type: "markdown", text: "Draft." }],
		});
		const opened = started.result?.taskId ?? "";
		const askId = askOf(opened);
		await reply(askId, { outcome: "follow_up", question: "Why?" });
		expect((await poll(opened)).result?.result?.structuredContent).toMatchObject({
			reply: { outcome: "follow_up", question: "Why?" },
		});

		const answered = await call("answer_follow_up", { askId, answer: "Because." });
		const followed = answered.result?.taskId ?? "";
		expect(followed).toBe(`${askId}:2`);
		expect((await poll(followed)).result).toMatchObject({ status: "working" });
		// The first task still reports the reply it completed with.
		expect((await poll(opened)).result).toMatchObject({ status: "completed" });

		await reply(askId, { outcome: "approved", note: "Fine" });
		expect((await poll(followed)).result?.result?.structuredContent).toEqual({
			askId,
			reply: { outcome: "approved", note: "Fine" },
		});
	});

	it("stop being followed when cancelled, leaving the ask open", async () => {
		const started = await call("ask_question", { question: "Cancel me?" });
		const taskId = started.result?.taskId ?? "";
		const askId = askOf(taskId);
		await poll(taskId);
		const cancelled = await rpc("tasks/cancel", { taskId }, { name: taskId });
		expect(cancelled.error, JSON.stringify(cancelled.error)).toBeUndefined();
		expect((await poll(taskId)).result).toMatchObject({ status: "cancelled" });
		const ask = await read(askId);
		expect(ask.status).toBe("awaiting_human");
		expect(ask.waiting).toBe(false);
	});

	it("refuse tasks the space does not hold", async () => {
		expect((await poll("not-a-task")).error?.code).toBe(-32602);
		expect((await poll("00000000-0000-0000-0000-000000000000:0")).error?.code).toBe(-32602);
		const started = await call("ask_question", { question: "Which turns exist?" });
		const askId = askOf(started.result?.taskId ?? "");
		expect((await poll(`${askId}:7`)).error?.code).toBe(-32602);
	});

	it("are never handed to a client that did not ask for them", async () => {
		const started = await call("ask_question", { question: "Tasks?" });
		const taskId = started.result?.taskId ?? "";
		expect((await poll(taskId, false)).error?.code).toBe(-32021);
	});
});
