import { Badge, Banner, Button, Checkbox, InputArea, Text } from "@cloudflare/kumo";
import { useAtomSet } from "@effect/atom-react";
import {
	ApiError,
	type BriefingAsk,
	type BriefingTree,
	foldBriefing,
	type PointNode,
	type PointReply,
	type PointTurn,
	type Reply,
	respondedProblem,
} from "@loopbackhq/sdk";
import {
	ArrowDown,
	CaretDown,
	CaretRight,
	Check,
	Checks,
	PaperPlaneRight,
	WarningCircle,
	X,
} from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { useEffect, useState } from "react";
import { Blocks, Prose } from "./content.tsx";
import { SEND_KEY, useNow } from "./hooks.ts";
import { useMe, whoIs } from "./people.ts";
import { replyAtom } from "./state.ts";
import { useClient, useInboxKeys } from "./context.tsx";
import { AgentSaid, PersonSaid } from "./thread.tsx";

/** What the person has written on a point, and whether they mean to resolve it, before sending. */
interface Draft {
	readonly text: string;
	readonly resolved: boolean;
	/**
	 * How long the thread was when the draft was written. A draft from before its point was last
	 * resolved is stale, even once the point is reopened; one written after is the person reopening it.
	 */
	readonly basis?: number;
}

const EMPTY: Draft = { text: "", resolved: false };

/** The draft that still counts on a point: one written since the point was last resolved. */
const draftOn = (drafts: Drafts, point: PointNode): Draft | undefined => {
	const draft = drafts[point.id];
	return draft !== undefined && (draft.basis ?? 0) >= point.resolvedAtEntry ? draft : undefined;
};

type Drafts = Readonly<Record<string, Draft>>;

const draftKey = (askId: string) => `loopback.drafts.${askId}`;

const readDrafts = (askId: string): Drafts => {
	try {
		return JSON.parse(localStorage.getItem(draftKey(askId)) ?? "{}") as Drafts;
	} catch {
		return {};
	}
};

/** Keeps a briefing's drafts in this browser, so a long one can be worked through over time. */
const useDrafts = (askId: string, basis: number) => {
	const [drafts, setDrafts] = useState<Drafts>(() => readDrafts(askId));
	const keep = (next: Drafts) => {
		setDrafts(next);
		try {
			if (Object.keys(next).length === 0) localStorage.removeItem(draftKey(askId));
			else localStorage.setItem(draftKey(askId), JSON.stringify(next));
		} catch {
			// Storage can be unavailable (a private window); drafts then last as long as the page.
		}
	};
	const update = (pointId: string, draft: Draft) => {
		const { [pointId]: _, ...rest } = drafts;
		keep(draft.text === "" && !draft.resolved ? rest : { ...rest, [pointId]: { ...draft, basis } });
	};
	return { drafts, update, clear: () => keep({}) };
};

/** Every point, in the order it is read. */
const inOrder = (points: readonly PointNode[]): PointNode[] =>
	points.flatMap((point) => [point, ...inOrder(point.points)]);

const allPoints = (tree: BriefingTree) => inOrder(tree.sections.flatMap((s) => s.points));

/**
 * The reply the drafts make. A draft left on a point resolved since it was written is dropped.
 * Words beneath a point being resolved go as resolved too, as the space would read them anyway.
 * Finishing resolves every remaining point: the uppermost of each open branch, and any written on.
 */
const replyFrom = (tree: BriefingTree, drafts: Drafts, finishing: boolean): PointReply[] => {
	const items: PointReply[] = [];
	const walk = (points: readonly PointNode[], covered: boolean) => {
		for (const point of points) {
			const draft = draftOn(drafts, point);
			const text = draft?.text.trim() ?? "";
			const resolving = draft?.resolved === true || finishing || covered;
			const included =
				text !== "" ||
				draft?.resolved === true ||
				(finishing && !covered && point.state !== "resolved");
			if (included) {
				items.push({
					point: point.id,
					...(text === "" ? {} : { text }),
					...(resolving ? { resolved: true } : {}),
				});
			}
			walk(point.points, covered || (included && resolving));
		}
	};
	for (const section of tree.sections) walk(section.points, false);
	return items;
};

const MARKER = {
	needs_you: { label: "Needs you", variant: "orange" },
	with_agent: { label: "With the agent", variant: "neutral" },
} as const;

/** The small uppercase label the inbox gives every group, as the list does "Your turn". */
const GROUP_LABEL = "text-xs font-medium uppercase tracking-wide text-kumo-subtle";

/** A point's number, in the chip a question's choices are numbered with. */
function PointId({ id }: { readonly id: string }) {
	return (
		<span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-kumo-line px-1 text-xs text-kumo-subtle tabular-nums">
			{id}
		</span>
	);
}

/** Where a folded point stands: a badge for its own state, and a count of what waits beneath it. */
function Marker({ point }: { readonly point: PointNode }) {
	const below = point.needsYou - (point.state === "needs_you" ? 1 : 0);
	return (
		<>
			{below === 0 ? null : (
				<span className="hidden text-xs text-kumo-subtle tabular-nums sm:inline">
					{below} below
				</span>
			)}
			{point.state === "needs_you" || point.state === "with_agent" ? (
				<Badge variant={MARKER[point.state].variant}>{MARKER[point.state].label}</Badge>
			) : null}
		</>
	);
}

/** That a reply is drafted on a point, marked as the list marks an agent waiting. */
function Drafted() {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-kumo-subtle">
			<span className="size-2 rounded-full bg-kumo-brand" />
			<span className="sr-only sm:not-sr-only">Draft</span>
		</span>
	);
}

function Turn({ turn, now }: { readonly turn: PointTurn; readonly now: number }) {
	const me = useMe();
	if (turn.author === "agent") {
		return <AgentSaid answer={turn.answer} content={turn.content} at={turn.at} now={now} />;
	}
	const who = whoIs(turn.by, me);
	const words = turn.text?.trim() ?? "";
	return (
		<PersonSaid
			title={turn.resolved ? `${who} resolved this` : `${who} wrote`}
			body={words === "" ? undefined : words}
			at={turn.at}
			now={now}
		/>
	);
}

interface Shared {
	readonly opened: ReadonlySet<string>;
	readonly toggle: (id: string) => void;
	readonly drafts: Drafts;
	readonly update: (id: string, draft: Draft) => void;
	/** Whether the person can still write: the briefing is open. */
	readonly writable: boolean;
	readonly now: number;
}

function PointItem({ point, shared }: { readonly point: PointNode; readonly shared: Shared }) {
	const open = shared.opened.has(point.id);
	const draft = draftOn(shared.drafts, point) ?? EMPTY;
	const resolved = point.state === "resolved";
	const drafted = draft.text.trim() !== "" || draft.resolved;
	const panel = `point-${point.id}`;
	return (
		<li id={`row-${point.id}`}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panel}
				onClick={() => shared.toggle(point.id)}
				className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-kumo-tint ${
					open ? "bg-kumo-tint" : ""
				}`}
			>
				<span className="shrink-0 text-kumo-subtle">
					{open ? <CaretDown size={12} /> : <CaretRight size={12} />}
				</span>
				<PointId id={point.id} />
				<Text truncate bold={point.state === "needs_you"}>
					{point.title}
				</Text>
				<span className="ml-auto flex shrink-0 items-center gap-2">
					{drafted ? <Drafted /> : null}
					<Marker point={point} />
				</span>
			</button>
			{open ? (
				<section
					id={panel}
					aria-label={`${point.id} ${point.title}`}
					className="flex flex-col gap-3 px-4 pt-1 pb-4 sm:pl-[4.25rem]"
				>
					{point.detail === undefined ? null : <Prose text={point.detail} />}
					{point.content === undefined ? null : <Blocks blocks={point.content} />}
					{point.turns.map((turn) => (
						<Turn key={`${turn.author}:${turn.at}`} turn={turn} now={shared.now} />
					))}
					{shared.writable ? (
						<div className="flex flex-col gap-2">
							<InputArea
								aria-label={`Your reply on point ${point.id}`}
								placeholder={
									resolved
										? "Write here to reopen this point"
										: "A question, a push-back or a comment"
								}
								value={draft.text}
								onValueChange={(text) => shared.update(point.id, { ...draft, text })}
								autoResize
								minRows={2}
								maxRows={10}
							/>
							{resolved ? null : (
								<Checkbox
									label="Resolved"
									checked={draft.resolved}
									onCheckedChange={(checked) =>
										shared.update(point.id, { ...draft, resolved: checked })
									}
								/>
							)}
						</div>
					) : null}
					{point.points.length === 0 ? null : <Points points={point.points} shared={shared} />}
				</section>
			) : null}
		</li>
	);
}

/**
 * One level of points, as a card of rows: what is still open, in order, then the resolved folded
 * into a count that opens like the list's "Recent".
 */
function Points({
	points,
	shared,
}: {
	readonly points: readonly PointNode[];
	readonly shared: Shared;
}) {
	const [showResolved, setShowResolved] = useState(false);
	const live = points.filter((point) => point.state !== "resolved");
	const resolved = points.filter((point) => point.state === "resolved");
	return (
		<ul className="divide-y divide-kumo-hairline overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
			{live.map((point) => (
				<PointItem key={point.id} point={point} shared={shared} />
			))}
			{resolved.length === 0 ? null : (
				<li>
					<button
						type="button"
						aria-expanded={showResolved}
						onClick={() => setShowResolved((shown) => !shown)}
						className={`flex w-full items-center gap-1.5 px-4 py-2 text-left hover:text-kumo-default ${GROUP_LABEL}`}
					>
						{showResolved ? <CaretDown size={12} /> : <CaretRight size={12} />}
						Resolved <span className="tabular-nums">· {resolved.length}</span>
					</button>
					{showResolved ? (
						<ul className="divide-y divide-kumo-hairline border-t border-kumo-hairline">
							{resolved.map((point) => (
								<PointItem key={point.id} point={point} shared={shared} />
							))}
						</ul>
					) : null}
				</li>
			)}
		</ul>
	);
}

/** The ids of a point and every point above it. */
const pathTo = (id: string): string[] =>
	id.split(".").map((_, depth, parts) => parts.slice(0, depth + 1).join("."));

/**
 * A briefing's points, to work through one at a time: each folded to a line until opened, with its
 * own thread and a box to reply on it, and one bar that sends everything written since last time.
 */
export function BriefingBody({
	ask,
	onReplied,
}: {
	readonly ask: BriefingAsk;
	readonly onReplied: () => void;
}) {
	const now = useNow();
	const send = useAtomSet(replyAtom(useClient()), { mode: "promiseExit" });
	const basis = ask.thread.length;
	const { drafts, update, clear } = useDrafts(ask.id, basis);
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	const [cursor, setCursor] = useState<string | null>(null);
	const [sending, setSending] = useState<string | null>(null);
	const [error, setError] = useState<{
		readonly title: string;
		readonly description: string;
	} | null>(null);

	const closed = ask.status === "closed";
	useEffect(() => {
		if (closed) clear();
		// Only a briefing closing clears its drafts; `clear` is new on every render.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [closed]);

	const tree = foldBriefing(ask.prompt, ask.thread);
	const yourMove = ask.status === "awaiting_human";
	const busy = sending !== null;
	const items = replyFrom(tree, drafts, false);
	const reply: Reply = { outcome: "responded", points: items };
	const problem = items.length === 0 ? null : respondedProblem(ask.prompt, ask.thread, reply);
	const finishes =
		items.length > 0 &&
		problem === null &&
		foldBriefing(ask.prompt, [...ask.thread, { author: "human", reply, at: "" }]).resolved;

	const toggle = (id: string) =>
		setOpened((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const needing = allPoints(tree).filter((point) => point.state === "needs_you");
	const next = () => {
		const at = needing.findIndex((point) => point.id === cursor);
		const target = needing[(at + 1) % needing.length];
		if (target === undefined) return;
		setCursor(target.id);
		setOpened((current) => new Set([...current, ...pathTo(target.id)]));
		requestAnimationFrame(() =>
			document.getElementById(`row-${target.id}`)?.scrollIntoView?.({ block: "nearest" }),
		);
	};

	const submit = async (key: string, sent: Reply) => {
		setSending(key);
		setError(null);
		const exit = await send({ askId: ask.id, reply: sent });
		setSending(null);
		if (Exit.isSuccess(exit)) {
			clear();
			onReplied();
			return;
		}
		// As with any reply: one Loopback refused will not go through as it is; one that never
		// reached it can simply be sent again. Either way the drafts are kept.
		const failure = Cause.squash(exit.cause);
		const reason = failure instanceof Error ? failure.message : "no reason given";
		setError(
			failure instanceof ApiError && failure.status >= 400 && failure.status < 500
				? { title: "Your replies were not accepted", description: reason }
				: {
						title: "Your replies were not sent",
						description: `Loopback could not take them just now (${reason}), so the agent still has nothing. Send them again.`,
					},
		);
	};

	const shared: Shared = { opened, toggle, drafts, update, writable: !closed, now };
	const sendLabel = finishes
		? "Finish"
		: items.length === 0
			? "Send"
			: `Send ${items.length === 1 ? "1 reply" : `${items.length} replies`}`;
	const canSend = !busy && yourMove && items.length > 0 && problem === null;

	// ⌘↵ (Ctrl↵ off Apple's keyboards) sends, as it does on every other ask.
	useInboxKeys((event) => {
		if (!canSend || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
		event.preventDefault();
		void submit("send", reply);
	});

	return (
		<div className="flex flex-col gap-6">
			{needing.length === 0 || !yourMove ? null : (
				<div className="flex items-center gap-2">
					<Text variant="secondary" size="sm">
						{needing.length === 1 ? "1 point needs you" : `${needing.length} points need you`}
					</Text>
					<Button size="sm" variant="ghost" icon={<ArrowDown />} onClick={next}>
						Next point that needs you
					</Button>
				</div>
			)}

			{tree.sections.map((section, index) => (
				<section key={section.title ?? `section-${index}`} className="flex flex-col gap-2">
					{section.title === undefined ? null : <h2 className={GROUP_LABEL}>{section.title}</h2>}
					<Points points={section.points} shared={shared} />
				</section>
			))}

			{closed ? null : (
				<div className="sticky bottom-4 flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
					{error === null ? null : (
						<Banner
							role="alert"
							variant="error"
							icon={<WarningCircle />}
							title={error.title}
							description={error.description}
						/>
					)}
					{yourMove ? (
						problem === null ? null : (
							<Text variant="secondary" size="sm">
								{problem}
							</Text>
						)
					) : (
						<Text variant="secondary" size="sm">
							The agent is answering your replies. You can keep drafting meanwhile.
						</Text>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="primary"
							icon={finishes ? <Check /> : <PaperPlaneRight />}
							loading={sending === "send"}
							disabled={!canSend}
							onClick={() => void submit("send", reply)}
						>
							{sendLabel}
						</Button>
						<Button
							icon={<Checks />}
							loading={sending === "finish"}
							disabled={busy || !yourMove}
							onClick={() =>
								void submit("finish", {
									outcome: "responded",
									points: replyFrom(tree, drafts, true),
								})
							}
						>
							Finish now
						</Button>
						<Button
							variant="ghost"
							icon={<X />}
							loading={sending === "dismiss"}
							disabled={busy}
							onClick={() => void submit("dismiss", { outcome: "dismissed" })}
						>
							Dismiss
						</Button>
						<span className="ml-auto hidden text-xs text-kumo-subtle sm:inline">
							{SEND_KEY}↵ sends
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
