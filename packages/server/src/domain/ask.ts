import type {
	Ask,
	AskStatus,
	Block,
	Entry,
	QuestionInput,
	QuestionPrompt,
	Reply,
	ReviewInput,
	ReviewPrompt,
} from "@loopbackhq/protocol";
import { Effect } from "effect";
import { AskClosed, ContentInvalid, NotYourTurn, ReplyInvalid } from "./errors.ts";

/** An ask as the space stores it: everything but its thread and whether an agent is waiting. */
export type AskRecord = AskHead &
	(
		| { readonly kind: "question"; readonly prompt: QuestionPrompt }
		| { readonly kind: "review"; readonly prompt: ReviewPrompt; readonly revises: string | null }
	);

interface AskHead {
	readonly id: string;
	/** What a retried call is recognised by. See `fingerprint`. */
	readonly key: string;
	readonly status: AskStatus;
	readonly project: string | null;
	readonly client: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt: string | null;
	/** The last time an agent call was blocked on this ask. */
	readonly lastWaitedAt: string | null;
}

/** One turn of a thread as stored, with whether a human reply has been handed to an agent. */
export interface EntryRecord {
	readonly askId: string;
	readonly seq: number;
	readonly entry: Entry;
	readonly deliveredAt: string | null;
}

/** How long a retried call may still join the ask it opened, measured from its last wait. */
export const REATTACH_WINDOW_MS = 60 * 60 * 1000;

/**
 * The most an agent's opening or answer may hold, as JSON. Each is one SQLite row, which holds at
 * most 2 MB, and the snapshot an inbox starts from carries every open ask in one WebSocket frame.
 */
export const MAX_ASK_BYTES = 256 * 1024;

/** Refuses what an agent sends when it is too large to keep and show. */
export const checkSize = (content: unknown): Effect.Effect<void, ContentInvalid> => {
	const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
	return bytes <= MAX_ASK_BYTES
		? Effect.void
		: Effect.fail(
				new ContentInvalid({
					reason: `This is too large to show: ${Math.ceil(bytes / 1024)} KiB, where the most is ${MAX_ASK_BYTES / 1024} KiB. Show the part that matters, or split it into several reviews.`,
				}),
			);
};

export const questionPrompt = (input: QuestionInput): QuestionPrompt => ({
	question: input.question,
	options: input.options ?? [],
	multiple: input.multiple ?? false,
	...(input.context === undefined ? {} : { context: input.context }),
});

export const reviewPrompt = (input: ReviewInput): ReviewPrompt => ({
	title: input.title,
	content: input.content,
	...(input.summary === undefined ? {} : { summary: input.summary }),
});

/** The uploads a set of blocks shows. */
export const imagesIn = (blocks: readonly Block[]): string[] =>
	blocks.flatMap((block) => (block.type === "image" ? [block.uploadId] : []));

/** The ask in its wire shape. */
export const toAsk = (record: AskRecord, thread: readonly EntryRecord[], waiting: boolean): Ask => {
	const common = {
		id: record.id,
		status: record.status,
		waiting,
		thread: thread.map((row) => row.entry),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.project === null ? {} : { project: record.project }),
		...(record.client === null ? {} : { client: record.client }),
		...(record.closedAt === null ? {} : { closedAt: record.closedAt }),
	};
	return record.kind === "question"
		? { kind: "question", prompt: record.prompt, ...common }
		: {
				kind: "review",
				prompt: record.prompt,
				...(record.revises === null ? {} : { revises: record.revises }),
				...common,
			};
};

/** Where an ask stands once a reply lands: open for the agent after a follow-up, closed otherwise. */
export const statusAfter = (reply: Reply): AskStatus =>
	reply.outcome === "follow_up" ? "awaiting_agent" : "closed";

/**
 * Whether a person may make this reply now. The rules the contract cannot state as a schema:
 * whose turn it is, which outcomes fit which kind, and that an answer's choices are among those
 * offered.
 */
export const checkReply = (
	record: AskRecord,
	reply: Reply,
): Effect.Effect<void, AskClosed | NotYourTurn | ReplyInvalid> => {
	if (record.status === "closed") return Effect.fail(new AskClosed({ askId: record.id }));
	if (record.status === "awaiting_agent") {
		return Effect.fail(new NotYourTurn({ askId: record.id, turn: "agent" }));
	}
	const invalid = (reason: string) => Effect.fail(new ReplyInvalid({ reason }));
	switch (reply.outcome) {
		case "follow_up":
		case "dismissed":
			return Effect.void;
		case "approved":
		case "changes_requested":
			return record.kind === "review"
				? Effect.void
				: invalid(`"${reply.outcome}" is a reply to a review, and this ask is a question.`);
		case "answered": {
			if (record.kind !== "question") {
				return invalid(`"answered" is a reply to a question, and this ask is a review.`);
			}
			const offered = new Set(record.prompt.options.map((option) => option.label));
			const unknown = reply.selected.filter((label) => !offered.has(label));
			if (unknown.length > 0) {
				return invalid(
					`Not among the choices offered: ${unknown.map((l) => `"${l}"`).join(", ")}.`,
				);
			}
			if (new Set(reply.selected).size !== reply.selected.length) {
				return invalid("A choice is selected more than once.");
			}
			if (!record.prompt.multiple && reply.selected.length > 1) {
				return invalid("This question takes one choice.");
			}
			if (reply.selected.length === 0 && (reply.text ?? "").trim() === "") {
				return invalid("An answer needs a choice or some text.");
			}
			return Effect.void;
		}
	}
};

/** Object keys sorted at every depth, so equal inputs serialise equally however they were built. */
const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, field]) => field !== undefined)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, field]) => [key, canonical(field)]),
	);
};

/**
 * What identifies a call as a retry of one already made: the hex SHA-256 of what was asked, by
 * which client, for which project. Equal inputs from another session share it too, which is why a
 * match only counts inside `REATTACH_WINDOW_MS`.
 */
export const fingerprint = (subject: unknown): Effect.Effect<string> =>
	sha256(JSON.stringify(canonical(subject)));

/** The hex SHA-256 of some text: how secrets are kept at rest, and how asks are fingerprinted. */
export const sha256 = (text: string): Effect.Effect<string> =>
	Effect.promise(async () => {
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		);
		return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	});
