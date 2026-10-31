import { RegistryProvider } from "@effect/atom-react";
import { type Ask, type Entry, numberBriefing, type Reply } from "@loopbackhq/sdk";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskDetail } from "../src/web/detail.tsx";
import { tokenAtom } from "../src/web/state.ts";

const prompt = numberBriefing({
	title: "What the migration changes",
	summary: "Three changes, in two parts.",
	sections: [
		{
			title: "Storage",
			points: [
				{ title: "Sessions move to D1", detail: "Out of KV, into D1." },
				{ title: "R2 keeps images" },
			],
		},
		{ title: "Auth", points: [{ title: "Tokens are hashed at rest" }] },
	],
});

const briefing = (thread: Entry[] = [], status: Ask["status"] = "awaiting_human"): Ask => ({
	id: "b1",
	kind: "briefing",
	prompt,
	status,
	waiting: true,
	project: "loopback",
	thread,
	createdAt: "2026-10-30T10:00:00.000Z",
	updatedAt: "2026-10-30T10:00:00.000Z",
});

/** Point 1 asked about and answered, with a sub-point beneath it. */
const answeredRound: Entry[] = [
	{
		author: "human",
		reply: { outcome: "responded", points: [{ point: "1", text: "Why D1?" }] },
		at: "2026-10-30T10:01:00.000Z",
	},
	{
		author: "agent",
		answer: "Two reasons.",
		point: "1",
		points: [{ id: "1.1", title: "Queries across sessions" }],
		at: "2026-10-30T10:02:00.000Z",
	},
];

let sent: { url: string; reply: Reply }[] = [];

beforeEach(() => {
	sent = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		sent.push({ url, reply: JSON.parse(init?.body as string) });
		return Response.json({ ...briefing(), status: "awaiting_agent" });
	});
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.unstubAllGlobals();
});

const show = (ask: Ask) =>
	render(
		<RegistryProvider initialValues={[[tokenAtom, "token"]]}>
			<AskDetail ask={ask} />
		</RegistryProvider>,
	);

/** A point's folded line, found by its title. */
const row = (title: string) => screen.getByRole("button", { name: new RegExp(title) });

/** Opens a point and gives back the panel beneath it. */
const open = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
	await user.click(row(title));
	return screen.getByRole("region", { name: new RegExp(title) });
};

describe("a briefing", () => {
	it("shows every point as one collapsed line with its id, title and state", () => {
		show(briefing());
		expect(screen.getByRole("heading", { name: "What the migration changes" })).toBeInTheDocument();
		expect(screen.getByText("Storage")).toBeInTheDocument();
		expect(screen.getByText("Auth")).toBeInTheDocument();
		for (const title of ["Sessions move to D1", "R2 keeps images", "Tokens are hashed at rest"]) {
			expect(row(title)).toHaveAttribute("aria-expanded", "false");
		}
		expect(within(row("Sessions move to D1")).getByText("1")).toBeInTheDocument();
		expect(within(row("Tokens are hashed at rest")).getByText("3")).toBeInTheDocument();
		expect(screen.getAllByText("Needs you")).toHaveLength(3);
		expect(screen.queryByText("Out of KV, into D1.")).toBeNull();
	});

	it("opens a point to its detail, its own thread and its sub-points", async () => {
		const user = userEvent.setup();
		show(briefing(answeredRound));
		const panel = await open(user, "Sessions move to D1");
		expect(row("Sessions move to D1")).toHaveAttribute("aria-expanded", "true");
		expect(within(panel).getByText("Out of KV, into D1.")).toBeInTheDocument();
		expect(within(panel).getByText("Why D1?")).toBeInTheDocument();
		expect(within(panel).getByText("Two reasons.")).toBeInTheDocument();
		expect(row("Queries across sessions")).toHaveAttribute("aria-expanded", "false");
	});

	it("sends what was written and resolved as one reply", async () => {
		const user = userEvent.setup();
		show(briefing());
		const first = await open(user, "Sessions move to D1");
		await user.click(within(first).getByRole("checkbox", { name: "Resolved" }));
		const second = await open(user, "R2 keeps images");
		await user.type(within(second).getByRole("textbox"), "Why?");
		await user.click(screen.getByRole("button", { name: "Send 2 replies" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.url).toMatch(/\/api\/v1\/asks\/b1\/reply$/);
		expect(sent[0]?.reply).toEqual({
			outcome: "responded",
			points: [
				{ point: "1", resolved: true },
				{ point: "2", text: "Why?" },
			],
		});
	});

	it("resolves words beneath a point resolved in the same reply", async () => {
		const user = userEvent.setup();
		show(briefing(answeredRound));
		const parent = await open(user, "Sessions move to D1");
		await user.click(within(parent).getByRole("checkbox", { name: "Resolved" }));
		await user.type(
			within(await open(user, "Queries across sessions")).getByRole("textbox"),
			"Noted.",
		);
		await user.type(within(await open(user, "R2 keeps images")).getByRole("textbox"), "Which?");
		await user.click(screen.getByRole("button", { name: "Send 3 replies" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({
			outcome: "responded",
			points: [
				{ point: "1", resolved: true },
				{ point: "1.1", text: "Noted.", resolved: true },
				{ point: "2", text: "Which?" },
			],
		});
	});

	it("reopens a resolved point when written on", async () => {
		const user = userEvent.setup();
		show(
			briefing([
				{
					author: "human",
					reply: {
						outcome: "responded",
						points: [
							{ point: "1", text: "Why?" },
							{ point: "2", resolved: true },
						],
					},
					at: "2026-10-30T10:01:00.000Z",
				},
				{ author: "agent", answer: "Because.", point: "1", at: "2026-10-30T10:02:00.000Z" },
			]),
		);
		await user.click(screen.getByRole("button", { name: "Resolved · 1" }));
		await user.type(
			within(await open(user, "R2 keeps images")).getByRole("textbox"),
			"Actually, which bucket?",
		);
		await user.click(screen.getByRole("button", { name: "Send 1 reply" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({
			outcome: "responded",
			points: [{ point: "2", text: "Actually, which bucket?" }],
		});
	});

	it("keeps words written on a resolved point while the agent answers", async () => {
		const user = userEvent.setup();
		const replied: Entry = {
			author: "human",
			reply: {
				outcome: "responded",
				points: [
					{ point: "1", text: "Why D1?" },
					{ point: "2", resolved: true },
				],
			},
			at: "2026-10-30T10:01:00.000Z",
		};
		const { rerender } = render(
			<RegistryProvider initialValues={[[tokenAtom, "token"]]}>
				<AskDetail ask={briefing([replied], "awaiting_agent")} />
			</RegistryProvider>,
		);
		await user.click(screen.getByRole("button", { name: "Resolved · 1" }));
		await user.type(
			within(await open(user, "R2 keeps images")).getByRole("textbox"),
			"Actually, which bucket?",
		);
		rerender(
			<RegistryProvider initialValues={[[tokenAtom, "token"]]}>
				<AskDetail
					ask={briefing([
						replied,
						{ author: "agent", answer: "Queries.", point: "1", at: "2026-10-30T10:02:00.000Z" },
					])}
				/>
			</RegistryProvider>,
		);
		await user.click(screen.getByRole("button", { name: "Send 1 reply" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({
			outcome: "responded",
			points: [{ point: "2", text: "Actually, which bucket?" }],
		});
	});

	it("never brings back a draft from before a point was resolved, once it is reopened", async () => {
		const user = userEvent.setup();
		localStorage.setItem(
			"loopback.drafts.b1",
			JSON.stringify({ "1": { text: "Old words", resolved: false, basis: 2 } }),
		);
		show(
			briefing([
				...answeredRound,
				{
					author: "human",
					reply: {
						outcome: "responded",
						points: [
							{ point: "1", resolved: true },
							{ point: "2", text: "?" },
						],
					},
					at: "2026-10-30T10:03:00.000Z",
				},
				{ author: "agent", answer: "Bucket.", point: "2", at: "2026-10-30T10:04:00.000Z" },
				{
					author: "human",
					reply: { outcome: "responded", points: [{ point: "1.1", text: "Wait" }] },
					at: "2026-10-30T10:05:00.000Z",
				},
				{ author: "agent", answer: "Counting.", point: "1.1", at: "2026-10-30T10:06:00.000Z" },
			]),
		);
		expect(within(await open(user, "Sessions move to D1")).getAllByRole("textbox")[0]).toHaveValue(
			"",
		);
	});

	it("reads plain Send until something is written or resolved", () => {
		show(briefing());
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("reads Finish when sending would resolve everything", async () => {
		const user = userEvent.setup();
		show(briefing());
		for (const title of ["Sessions move to D1", "R2 keeps images", "Tokens are hashed at rest"]) {
			await user.click(within(await open(user, title)).getByRole("checkbox", { name: "Resolved" }));
		}
		expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
	});

	it("explains why it cannot send when nothing is left for the agent", async () => {
		const user = userEvent.setup();
		show(briefing());
		await user.click(
			within(await open(user, "R2 keeps images")).getByRole("checkbox", { name: "Resolved" }),
		);
		expect(screen.getByRole("button", { name: "Send 1 reply" })).toBeDisabled();
		expect(screen.getByText(/Nothing here for the agent to answer/)).toBeInTheDocument();
	});

	it("resolves every remaining point with Finish now", async () => {
		const user = userEvent.setup();
		show(briefing());
		await user.type(within(await open(user, "R2 keeps images")).getByRole("textbox"), "Fine");
		await user.click(screen.getByRole("button", { name: "Finish now" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({
			outcome: "responded",
			points: [
				{ point: "1", resolved: true },
				{ point: "2", text: "Fine", resolved: true },
				{ point: "3", resolved: true },
			],
		});
	});

	it("keeps drafts across a remount, and clears them once sent", async () => {
		const user = userEvent.setup();
		show(briefing());
		await user.type(within(await open(user, "R2 keeps images")).getByRole("textbox"), "Why?");
		cleanup();
		show(briefing());
		expect(within(await open(user, "R2 keeps images")).getByRole("textbox")).toHaveValue("Why?");
		await user.click(screen.getByRole("button", { name: "Send 1 reply" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		await waitFor(() => expect(localStorage.getItem("loopback.drafts.b1")).toBeNull());
	});

	it("never sends a draft for a point already resolved", async () => {
		const user = userEvent.setup();
		localStorage.setItem(
			"loopback.drafts.b1",
			JSON.stringify({ "2": { text: "Stale", resolved: false } }),
		);
		show(
			briefing([
				{
					author: "human",
					reply: {
						outcome: "responded",
						points: [
							{ point: "1", text: "Why?" },
							{ point: "2", resolved: true },
						],
					},
					at: "2026-10-30T10:01:00.000Z",
				},
				{ author: "agent", answer: "Because.", point: "1", at: "2026-10-30T10:02:00.000Z" },
			]),
		);
		await user.type(
			within(await open(user, "Tokens are hashed at rest")).getByRole("textbox"),
			"Ok?",
		);
		await user.click(screen.getByRole("button", { name: "Send 1 reply" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "responded", points: [{ point: "3", text: "Ok?" }] });
	});

	it("allows only Dismiss while it is the agent's move", async () => {
		const user = userEvent.setup();
		show(briefing(answeredRound.slice(0, 1), "awaiting_agent"));
		expect(screen.getByText(/The agent is answering/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Finish now" })).toBeDisabled();
		expect(screen.getByRole("button", { name: /^Send/ })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "dismissed" });
	});

	it("folds resolved points into a count at their level", async () => {
		const user = userEvent.setup();
		show(
			briefing([
				{
					author: "human",
					reply: {
						outcome: "responded",
						points: [
							{ point: "1", text: "Why?" },
							{ point: "2", resolved: true },
						],
					},
					at: "2026-10-30T10:01:00.000Z",
				},
				{ author: "agent", answer: "Because.", point: "1", at: "2026-10-30T10:02:00.000Z" },
			]),
		);
		const folded = screen.getByRole("button", { name: "Resolved · 1" });
		expect(folded).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("button", { name: /R2 keeps images/ })).toBeNull();
		await user.click(folded);
		expect(row("R2 keeps images")).toBeInTheDocument();
	});

	it("jumps to the next point that needs the person", async () => {
		const user = userEvent.setup();
		show(briefing(answeredRound));
		const next = screen.getByRole("button", { name: /Next point that needs you/ });
		await user.click(next);
		expect(row("Sessions move to D1")).toHaveAttribute("aria-expanded", "true");
		await user.click(next);
		expect(row("Queries across sessions")).toHaveAttribute("aria-expanded", "true");
	});
});
