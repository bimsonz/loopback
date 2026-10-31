import {
	type Ask,
	type BriefingAsk,
	findPoint,
	foldBriefing,
	type Responded,
	type ToolReply,
} from "@loopbackhq/protocol";
import {
	type AuthInfo,
	type CallToolResult,
	createMcpHandler,
	McpServer,
	MissingRequiredClientCapabilityError,
	ProtocolError,
	ProtocolErrorCode,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { Effect } from "effect";
import { z } from "zod";
import {
	briefingAnswerInputSchema,
	briefingInputSchema,
	followUpInputSchema,
	inboxLinkSchema,
	inboxRequestSchema,
	questionInputSchema,
	reviewInputSchema,
	uploadRequestSchema,
	uploadTicketSchema,
} from "../generated/schemas.gen.ts";
import type { AskNotFound } from "../domain/errors.ts";
import type { Delivery, TaskState } from "../space/operations.ts";
import type { SpaceClient } from "../space/rpc.ts";
import type { Access } from "./gate.ts";
import { incident, run, Unhandled, type WorkerRuntime } from "./run.ts";
import { VERSION } from "../version.ts";
import { Spaces } from "./spaces.ts";

/** How long each wait for a reply is held before the tool reports progress and waits again. */
const LAP_MS = 25_000;

/** The MCP Tasks extension: a tool call that returns at once and completes later. */
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * How often a client should poll a task: the most a reply waits before the agent sees it. Briskly
 * while a quick answer is likely, then less often, since each poll is a request to the space.
 */
const pollEvery = (startedAt: string, now: number): number => {
	const age = now - Date.parse(startedAt);
	return age < 2 * 60_000 ? 2_000 : age < 30 * 60_000 ? 10_000 : 30_000;
};

const INSTRUCTIONS = `Loopback puts what you need from the person you are working for in front of them, in a live inbox, and hands their reply back to you as the tool result.

Use it whenever you need a decision, a preference, information only they have, or their sign-off. Use it instead of guessing, instead of asking in your reply, and instead of your client's built-in question prompt: the person works across many projects at once and answers everything from this one inbox.
- ask_question for anything you would otherwise ask in chat. Offer choices when there are clear ones.
- request_review when they say "show me", "let me see" or "run it by me", or before you finalise work they should approve: copy, a plan, code, a diff, a screenshot. Put the work itself in the content.
- send_briefing when they ask you to explain or walk them through something that breaks into several points: findings, options, steps, a list of changes. They reply on each point on its own, instead of on a list in your reply.
- create_image_upload first when the review includes an image.
- open_inbox when the person asks where their inbox or dashboard is, or to send them to an ask.

People can take minutes to reply. Where your client supports background tasks, each of these returns at once: carry on with other work, raise more asks if you need to, and the person's reply reaches you when they give it. Otherwise the call waits for the reply.

A reply whose outcome is follow_up is a question back to you: answer it with answer_follow_up, which brings their decision the same way. After changes_requested, revise and call request_review again with revises set to the earlier review's id. Replies on a briefing come back keyed to its points: answer every point they wrote on with answer_briefing, which brings their next replies the same way, until every point is resolved.

Every ask names its project: the name of the folder at the root of the repository you are working in (the last part of \`git rev-parse --show-toplevel\`), or of the working directory outside one. Use the same name every time.`;

/** What the factory needs about the request it is building a server for. */
interface McpCaller {
	readonly runtime: WorkerRuntime;
	readonly access: Access;
	readonly origin: string;
	readonly requestId: string;
}

const clientInfoSchema = z.object({ name: z.string(), version: z.string().optional() });

/** The MCP client that sent this request, when the request says. */
const clientOf = (ctx: ServerContext): string | undefined => {
	const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {};
	const meta: Record<string, unknown> = ctx.mcpReq._meta ?? {};
	const parsed = clientInfoSchema.safeParse(
		envelope["io.modelcontextprotocol/clientInfo"] ?? meta["io.modelcontextprotocol/clientInfo"],
	);
	if (!parsed.success) return undefined;
	return parsed.data.version === undefined
		? parsed.data.name
		: `${parsed.data.name} ${parsed.data.version}`;
};

const capabilitiesSchema = z.object({
	extensions: z.record(z.string(), z.unknown()).optional(),
});

/** Whether the client declared the Tasks extension on this request; only then may a tool answer with a task. */
const supportsTasks = (ctx: ServerContext): boolean => {
	const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {};
	const parsed = capabilitiesSchema.safeParse(
		envelope["io.modelcontextprotocol/clientCapabilities"],
	);
	return parsed.success && parsed.data.extensions?.[TASKS_EXTENSION] !== undefined;
};

const requireTasks = (ctx: ServerContext) => {
	if (!supportsTasks(ctx)) {
		throw new MissingRequiredClientCapabilityError({
			requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
		});
	}
};

/**
 * A task follows the reply to one of the agent's turns on an ask: `<askId>:<turn>`, where the turn
 * is the thread entry the agent's move ended with, 0 for opening the ask. Ask ids are random, and
 * every task request passes the same gate as the ask itself.
 */
const taskIdOf = (askId: string, turn: number) => `${askId}:${turn}`;

const unknownTask = (taskId: string) =>
	new ProtocolError(ProtocolErrorCode.InvalidParams, `No task "${taskId}".`);

const taskOf = (taskId: string): { readonly askId: string; readonly turn: number } => {
	const split = taskId.lastIndexOf(":");
	const turn = Number(taskId.slice(split + 1));
	if (split <= 0 || !Number.isSafeInteger(turn) || turn < 0) throw unknownTask(taskId);
	return { askId: taskId.slice(0, split), turn };
};

const text = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }] });

const refused = (message: string): CallToolResult => ({ ...text(message), isError: true });

/** "2", "2 and 3", "1, 2 and 3". */
const listed = (items: readonly string[]): string =>
	items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** A briefing, and where in its thread a reply landed. */
interface Landed {
	readonly briefing: BriefingAsk;
	readonly seq: number;
}

/**
 * Replies on a briefing, each point named with its title, and what the agent owes now. The briefing
 * is read as it stood when this reply landed, so a task polled again later says the same.
 */
const describeResponded = (askId: string, reply: Responded, landed?: Landed): string => {
	const tree =
		landed === undefined
			? undefined
			: foldBriefing(landed.briefing.prompt, landed.briefing.thread.slice(0, landed.seq));
	const named = (id: string) => {
		const title = tree === undefined ? undefined : findPoint(tree, id)?.title;
		return title === undefined ? id : `${id} (${title})`;
	};
	const lines = reply.points.map((item) => {
		const wrote = item.text?.trim() ?? "";
		// As the fold reads it: words on or beneath a point resolved in the same reply are closing
		// notes, and its record of this turn on the point says so.
		const turn = tree === undefined ? undefined : findPoint(tree, item.point)?.turns.at(-1);
		const settled = turn?.author === "human" ? turn.resolved : item.resolved === true;
		const said = settled
			? wrote === ""
				? "resolved."
				: `resolved, saying "${wrote}"`
			: `they wrote "${wrote}"`;
		return `- Point ${named(item.point)}: ${said}`;
	});
	const next =
		tree === undefined || tree.resolved
			? "The briefing is closed: every point is resolved. Act on what they said, or ask a new question if something is still unclear."
			: `Answer ${tree.owed.length === 1 ? "point" : "points"} ${listed(tree.owed.map(named))} with answer_briefing (askId: "${askId}"): each is owed an answer. You may answer other open points too, and break any point into sub-points.`;
	return ["The person replied on the briefing:", ...lines, "", next].join("\n");
};

/** What a reply means for the agent, said plainly. A briefing's replies name its points' titles. */
const describe = ({ askId, reply }: ToolReply, landed?: Landed): string => {
	switch (reply.outcome) {
		case "answered": {
			const chose =
				reply.selected.length === 0
					? ""
					: `They chose: ${reply.selected.map((label) => `"${label}"`).join(", ")}.`;
			const wrote =
				reply.text === undefined || reply.text.trim() === "" ? "" : `They wrote: ${reply.text}`;
			return ["The person answered.", chose, wrote].filter((part) => part !== "").join(" ");
		}
		case "approved":
			return reply.note === undefined ? "Approved." : `Approved, with a note: ${reply.note}`;
		case "changes_requested":
			return `Changes requested: ${reply.feedback}\n\nRevise the work, then call request_review again with revises: "${askId}".`;
		case "follow_up":
			return `The person asked a question before deciding: ${reply.question}\n\nAnswer it with answer_follow_up (askId: "${askId}"). This ask stays open, and that call returns their decision.`;
		case "dismissed":
			return "The person dismissed this without answering. Carry on with your best judgement, or ask differently.";
		case "responded":
			return describeResponded(askId, reply, landed);
	}
};

/** A reply as the agent receives it: in words, and as the contract's `ToolReply`. */
const answered = (delivery: Delivery, briefing?: BriefingAsk): CallToolResult => {
	const reply: ToolReply = { askId: delivery.askId, reply: delivery.reply };
	return {
		...text(describe(reply, briefing === undefined ? undefined : { briefing, seq: delivery.seq })),
		structuredContent: reply,
	};
};

/** The briefing a reply was given on, read only when the reply is one, to name its points. */
const briefingFor = (
	space: SpaceClient,
	reply: ToolReply | null,
): Effect.Effect<BriefingAsk | undefined, AskNotFound> =>
	reply?.reply.outcome === "responded"
		? Effect.map(space.get(reply.askId), (ask: Ask) => (ask.kind === "briefing" ? ask : undefined))
		: Effect.succeed(undefined);

/**
 * The turn an opened ask is followed from: its opening for a new ask, and the agent's latest move
 * for one a retried call rejoined, so its task completes with the reply still to come, not the first.
 */
const latestTurn = (ask: Ask): readonly [turn: number, at: string] => {
	const last = ask.thread.findLastIndex((entry) => entry.author === "agent");
	const entry = ask.thread[last];
	return entry === undefined ? [0, ask.createdAt] : [last + 1, entry.at];
};

/** A task in the shape `tasks/get` and a task-creating `tools/call` share. */
const taskView = (taskId: string, state: TaskState, briefing?: BriefingAsk) => ({
	taskId,
	status: state.status,
	...(state.status === "working"
		? { statusMessage: "Waiting for the person to reply in Loopback." }
		: {}),
	createdAt: state.createdAt,
	lastUpdatedAt: state.lastUpdatedAt,
	ttlMs: null,
	pollIntervalMs: pollEvery(state.createdAt, Date.now()),
	...(state.reply === null ? {} : { result: answered(state.reply, briefing) }),
});

/**
 * The answer to a call that became a background task. The SDK types a tool's result as a
 * `CallToolResult`, but passes a task through to the client unchanged: this is the one place the
 * two shapes meet.
 */
const started = (askId: string, turn: number, at: string): CallToolResult =>
	({
		resultType: "task",
		...taskView(taskIdOf(askId, turn), {
			status: "working",
			createdAt: at,
			lastUpdatedAt: at,
			reply: null,
		}),
	}) as unknown as CallToolResult;

/** Tells the client the call is alive, which keeps its idle timer from giving up on a long wait. */
const reportProgress = (ctx: ServerContext, step: number) =>
	Effect.promise(async () => {
		const progressToken = ctx.mcpReq._meta?.progressToken;
		if (progressToken === undefined) return;
		await ctx.mcpReq.notify({
			method: "notifications/progress",
			params: { progressToken, progress: step, message: "Waiting for the person to reply" },
		});
	});

/**
 * Waits, in laps, until the person replies to the ask, reporting progress between laps, and takes
 * the reply. A call whose client has gone is interrupted before it takes it, which leaves the reply
 * for the client's retry. The ask was just opened or answered, so one that has vanished is a broken
 * invariant, not an error to report.
 */
const replyTo = (ctx: ServerContext, space: SpaceClient, askId: string) =>
	Effect.gen(function* () {
		for (let step = 0; ; step += 1) {
			yield* reportProgress(ctx, step);
			const delivery = yield* space.awaitReply(askId, LAP_MS);
			if (delivery !== null) {
				yield* space.markDelivered(askId, delivery.seq);
				return answered(delivery, yield* briefingFor(space, delivery));
			}
		}
	}).pipe(Effect.catchTag("AskNotFound", Effect.die));

const server = ({ runtime, access, origin, requestId }: McpCaller) => {
	const mcp = new McpServer({ name: "loopback", version: VERSION }, { instructions: INSTRUCTIONS });
	/**
	 * A call that died is logged, and the agent hears only the incident to quote. One its client
	 * abandoned has no one to tell.
	 */
	const died = (error: unknown): string => {
		if (error instanceof Unhandled && error.interrupted) throw error;
		return incident(error, requestId);
	};
	const serve = (
		ctx: ServerContext,
		program: (space: SpaceClient) => Effect.Effect<CallToolResult>,
	) =>
		run(
			runtime,
			ctx.mcpReq.signal,
			requestId,
			Spaces.use((spaces) => program(spaces.of(access))),
		).catch((error: unknown) => refused(died(error)));
	/**
	 * A client that can follow a background task gets one at once; any other waits for the reply,
	 * since that is the only way it can receive one.
	 */
	const settle = (
		ctx: ServerContext,
		space: SpaceClient,
		askId: string,
		turn: number,
		at: string,
	): Effect.Effect<CallToolResult> =>
		supportsTasks(ctx) ? Effect.succeed(started(askId, turn, at)) : replyTo(ctx, space, askId);

	/** Runs a `tasks/*` request against the task's ask; an ask or turn the space does not know is no task. */
	const task = async (
		ctx: ServerContext,
		taskId: string,
		program: (
			space: SpaceClient,
			askId: string,
			turn: number,
		) => Effect.Effect<TaskState, AskNotFound>,
	) => {
		requireTasks(ctx);
		const { askId, turn } = taskOf(taskId);
		const found = await run(
			runtime,
			ctx.mcpReq.signal,
			requestId,
			Spaces.use((spaces) => {
				const space = spaces.of(access);
				return Effect.flatMap(program(space, askId, turn), (state) =>
					Effect.map(briefingFor(space, state.reply), (briefing) => ({ state, briefing })),
				);
			}).pipe(Effect.catchTag("AskNotFound", () => Effect.succeed(null))),
		).catch((error: unknown) => {
			throw new ProtocolError(ProtocolErrorCode.InternalError, died(error));
		});
		if (found === null) throw unknownTask(taskId);
		return taskView(taskId, found.state, found.briefing);
	};

	mcp.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });
	const taskParams = z.object({ taskId: z.string() });

	mcp.server.setRequestHandler("tasks/get", { params: taskParams }, ({ taskId }, ctx) =>
		task(ctx, taskId, (space, askId, turn) => space.followTask(askId, turn)),
	);

	mcp.server.setRequestHandler("tasks/cancel", { params: taskParams }, async ({ taskId }, ctx) => {
		await task(ctx, taskId, (space, askId, turn) => space.cancelTask(askId, turn));
		return {};
	});

	// Loopback's tasks never ask the client for input, so there is nothing to update: input
	// responses a server does not recognise are ignored.
	mcp.server.setRequestHandler("tasks/update", { params: taskParams }, async ({ taskId }, ctx) => {
		await task(ctx, taskId, (space, askId, turn) => space.followTask(askId, turn));
		return {};
	});

	const waits = {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	};

	mcp.registerTool(
		"ask_question",
		{
			title: "Ask the person a question",
			description:
				"Ask the person you are working for a question. Use it whenever you need a decision, a preference or information only they have, instead of guessing, asking in your reply, or using a built-in question prompt: they answer everything from their Loopback inbox. Offer two to six choices when there are clear ones; they can always answer in their own words, ask you something back, or dismiss it. Their reply can take minutes: where your client supports background tasks this returns at once and the reply reaches you when it comes; otherwise it waits.",
			inputSchema: questionInputSchema,
			annotations: waits,
		},
		(input, ctx) =>
			serve(ctx, (space) =>
				Effect.gen(function* () {
					const client = clientOf(ctx);
					const ask = yield* space.open({
						kind: "question",
						input,
						actor: access.actor,
						...(client === undefined ? {} : { client }),
					});
					return yield* settle(ctx, space, ask.id, ...latestTurn(ask));
				}).pipe(
					Effect.catchTag(["ContentInvalid", "Declined"], (error) =>
						Effect.succeed(refused(error.reason)),
					),
				),
			),
	);

	mcp.registerTool(
		"request_review",
		{
			title: "Show the person work for review",
			description:
				'Show the person something you made and wait for their verdict: copy, a plan, code, a diff or a screenshot. Use it when they say "show me", "let me see" or "run it by me", and before you finalise anything they should sign off. Put the work itself in content, not a description of it. They can approve (perhaps with a note), request changes, ask you a question first, or dismiss it. For an image, call create_image_upload first. Returns at once as a background task where your client supports it; otherwise waits for their verdict.',
			inputSchema: reviewInputSchema,
			annotations: waits,
		},
		(input, ctx) =>
			serve(ctx, (space) =>
				Effect.gen(function* () {
					const client = clientOf(ctx);
					const ask = yield* space.open({
						kind: "review",
						input,
						actor: access.actor,
						...(client === undefined ? {} : { client }),
					});
					return yield* settle(ctx, space, ask.id, ...latestTurn(ask));
				}).pipe(
					Effect.catchTag(["ContentInvalid", "Declined"], (error) =>
						Effect.succeed(refused(error.reason)),
					),
				),
			),
	);

	mcp.registerTool(
		"answer_follow_up",
		{
			title: "Answer the person's question",
			description:
				"Answer a question the person asked back about one of your asks (a reply whose outcome is follow_up), then get their decision the same way the ask itself brings it. Include content when the answer involves something new to look at.",
			inputSchema: followUpInputSchema,
			annotations: waits,
		},
		(input, ctx) =>
			serve(ctx, (space) =>
				Effect.gen(function* () {
					const ask = yield* space.answerFollowUp(input);
					const answer = ask.thread.at(-1);
					return yield* settle(ctx, space, ask.id, ask.thread.length, answer?.at ?? ask.updatedAt);
				}).pipe(
					Effect.catchTags({
						AskNotFound: () => Effect.succeed(refused(`No ask "${input.askId}".`)),
						AskClosed: () =>
							Effect.succeed(refused("That ask is closed; the person has already decided.")),
						NotYourTurn: () =>
							Effect.succeed(
								refused(
									"The person has not asked anything back on that ask, so there is nothing to answer.",
								),
							),
						ContentInvalid: (error) => Effect.succeed(refused(error.reason)),
					}),
				),
			),
	);

	mcp.registerTool(
		"send_briefing",
		{
			title: "Brief the person, point by point",
			description:
				"Explain something that breaks into several points (findings, options, steps, a list of changes) so the person can reply on each point on its own: ask about one, push back on another, resolve the rest. Use it when they ask you to explain or walk them through something, instead of writing the list in your reply. Give each point a one-line title, which they see folded, and its detail beneath. Points are numbered for you, 1, 2, 3 and on, straight through every section, and their replies come back keyed to those numbers: answer them with answer_briefing. Returns at once as a background task where your client supports it; otherwise waits for their replies.",
			inputSchema: briefingInputSchema,
			annotations: waits,
		},
		(input, ctx) =>
			serve(ctx, (space) =>
				Effect.gen(function* () {
					const client = clientOf(ctx);
					const ask = yield* space.open({
						kind: "briefing",
						input,
						actor: access.actor,
						...(client === undefined ? {} : { client }),
					});
					return yield* settle(ctx, space, ask.id, ...latestTurn(ask));
				}).pipe(
					Effect.catchTag(["ContentInvalid", "Declined"], (error) =>
						Effect.succeed(refused(error.reason)),
					),
				),
			),
	);

	mcp.registerTool(
		"answer_briefing",
		{
			title: "Answer the person, point by point",
			description:
				"Answer the person's replies on a briefing: one answer for every point they wrote on without resolving it, and for any other open point you have more to say on. When a point needs drilling into, break it into sub-points, numbered beneath it (3.1, 3.2), which they can reply on in turn. Then get their next replies the same way the briefing brought these. The briefing closes once they resolve every point.",
			inputSchema: briefingAnswerInputSchema,
			annotations: waits,
		},
		(input, ctx) =>
			serve(ctx, (space) =>
				Effect.gen(function* () {
					// A retried move rejoins the turn it first took, which may no longer be the last.
					const { ask, turn } = yield* space.answerBriefing(input);
					const answer = ask.thread[turn - 1];
					return yield* settle(ctx, space, ask.id, turn, answer?.at ?? ask.updatedAt);
				}).pipe(
					Effect.catchTags({
						AskNotFound: () => Effect.succeed(refused(`No briefing "${input.askId}".`)),
						AskClosed: () =>
							Effect.succeed(
								refused(
									"The person closed that briefing. Act on what they said, or ask a new question if something is still unclear.",
								),
							),
						NotYourTurn: () =>
							Effect.succeed(
								refused(
									"The person has not replied on that briefing since your last answers, so there is nothing to answer yet.",
								),
							),
						ContentInvalid: (error) => Effect.succeed(refused(error.reason)),
					}),
				),
			),
	);

	mcp.registerTool(
		"open_inbox",
		{
			title: "Open the person's inbox",
			description:
				"Get the address of the person's Loopback inbox: the live page where they read and answer everything agents ask, across all their projects. Use it when they ask where their inbox or dashboard is, or to point them at one ask by its askId. Open the address for them with the system's open command if you can; otherwise give it to them.",
			inputSchema: inboxRequestSchema,
			outputSchema: inboxLinkSchema,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => {
			const url =
				input.askId === undefined ? `${origin}/` : `${origin}/#/${encodeURIComponent(input.askId)}`;
			return { ...text(`The person's inbox: ${url}`), structuredContent: { url } };
		},
	);

	mcp.registerTool(
		"create_image_upload",
		{
			title: "Upload an image for a review",
			description:
				"Get a one-time URL for uploading an image, such as a screenshot, to show in request_review. Run the command it returns with the file's path, then put the uploadId in an image block. The URL expires after fifteen minutes.",
			inputSchema: uploadRequestSchema,
			outputSchema: uploadTicketSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		(input, ctx) =>
			serve(ctx, (space) =>
				Effect.gen(function* () {
					const issued = yield* space.createUpload(input.contentType);
					const uploadUrl = `${origin}/api/v1/uploads/${issued.spaceId}/${issued.token}`;
					const command = `curl -sS --fail-with-body -X PUT -H 'Content-Type: ${issued.contentType}' --data-binary @FILE '${uploadUrl}'`;
					const ticket = {
						uploadId: issued.uploadId,
						uploadUrl,
						expiresAt: issued.expiresAt,
						maxBytes: issued.maxBytes,
						command,
					};
					return {
						...text(
							`Upload the image by running this, with FILE replaced by its path:\n\n${command}\n\nThen show it with an image block: { "type": "image", "uploadId": "${issued.uploadId}" }.`,
						),
						structuredContent: ticket,
					};
				}).pipe(Effect.catchTag("Declined", (error) => Effect.succeed(refused(error.reason)))),
			),
	);

	return mcp;
};

/**
 * The MCP endpoint. The gate runs first; what it established reaches the per-request server
 * through the `authInfo` the SDK passes along untouched.
 */
export const makeMcp = () => {
	const callers = new WeakMap<AuthInfo, McpCaller>();
	const handler = createMcpHandler(
		(ctx) => {
			const caller = ctx.authInfo === undefined ? undefined : callers.get(ctx.authInfo);
			if (caller === undefined)
				throw new Error("An MCP request reached the server without access.");
			return server(caller);
		},
		// Always stream, so a long wait starts its response at once and keep-alive frames flow.
		{ responseMode: "sse" },
	);
	return (request: Request, runtime: WorkerRuntime, access: Access, requestId: string) => {
		const authInfo: AuthInfo = { token: "", clientId: access.actor.id, scopes: [] };
		callers.set(authInfo, { runtime, access, origin: new URL(request.url).origin, requestId });
		return handler.fetch(request, { authInfo });
	};
};
