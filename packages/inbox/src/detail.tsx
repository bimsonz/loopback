import { Badge, Banner, Button, InputArea, Text } from "@cloudflare/kumo";
import { useAtomSet } from "@effect/atom-react";
import { ApiError, type Ask, type Entry, type QuestionAsk, type Reply } from "@loopbackhq/sdk";
import {
	ArrowLeft,
	Check,
	ChatTeardropText,
	PaperPlaneRight,
	WarningCircle,
	X,
} from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { Component, type ReactNode, useState } from "react";
import { BriefingBody } from "./briefing.tsx";
import { Blocks, Prose } from "./content.tsx";
import { AskLink, useClient, useInboxKeys, useNavigation } from "./context.tsx";
import { age, SEND_KEY, useNow } from "./hooks.ts";
import { KindIcon, Waiting } from "./list.tsx";
import { useMe, whoIs } from "./people.ts";
import { replyAtom } from "./state.ts";
import { AgentSaid, PersonSaid } from "./thread.tsx";

const STATUS = {
	awaiting_human: { label: "Your turn", variant: "orange" },
	awaiting_agent: { label: "Waiting on the agent", variant: "neutral" },
	closed: { label: "Closed", variant: "green" },
} as const;

/** A reply in the words of the person who gave it. */
const said = (reply: Reply, who: string): { readonly title: string; readonly body?: string } => {
	switch (reply.outcome) {
		case "answered": {
			const chose =
				reply.selected.length === 0
					? `${who} answered`
					: `${who} chose ${reply.selected.join(", ")}`;
			return reply.text === undefined ? { title: chose } : { title: chose, body: reply.text };
		}
		case "approved":
			return reply.note === undefined
				? { title: `${who} approved` }
				: { title: `${who} approved`, body: reply.note };
		case "changes_requested":
			return { title: `${who} asked for changes`, body: reply.feedback };
		case "follow_up":
			return { title: `${who} asked`, body: reply.question };
		case "dismissed":
			return { title: `${who} dismissed this` };
		case "responded":
			return {
				title: `${who} replied on ${reply.points.length} ${reply.points.length === 1 ? "point" : "points"}`,
			};
	}
};

function Turn({ entry, now }: { readonly entry: Entry; readonly now: number }) {
	const me = useMe();
	if (entry.author === "agent") {
		return <AgentSaid answer={entry.answer} content={entry.content} at={entry.at} now={now} />;
	}
	const { title, body } = said(entry.reply, whoIs(entry.by, me));
	return <PersonSaid title={title} body={body} at={entry.at} now={now} />;
}

/** The reply controls: one box for words, and the moves this kind of ask allows. */
function ReplyPanel({ ask, onReplied }: { readonly ask: Ask; readonly onReplied: () => void }) {
	const send = useAtomSet(replyAtom(useClient()), { mode: "promiseExit" });
	const [text, setText] = useState("");
	const [picked, setPicked] = useState<readonly string[]>([]);
	const [sending, setSending] = useState<string | null>(null);
	const [error, setError] = useState<{
		readonly title: string;
		readonly description: string;
	} | null>(null);
	const words = text.trim();

	const submit = async (key: string, reply: Reply) => {
		setSending(key);
		setError(null);
		const exit = await send({ askId: ask.id, reply });
		setSending(null);
		if (Exit.isSuccess(exit)) {
			setText("");
			setPicked([]);
			onReplied();
			return;
		}
		// A reply Loopback refused will not go through as it is; one that never reached it, or met
		// a fault there, can simply be sent again. Either way the agent has nothing yet.
		const failure = Cause.squash(exit.cause);
		const reason = failure instanceof Error ? failure.message : "no reason given";
		setError(
			failure instanceof ApiError && failure.status >= 400 && failure.status < 500
				? { title: "Your reply was not accepted", description: reason }
				: {
						title: "Your reply was not sent",
						description: `Loopback could not take it just now (${reason}), so the agent still has nothing. Send it again.`,
					},
		);
	};
	const note = words === "" ? {} : { text: words };

	const question = ask.kind === "question" ? ask : null;
	const choose = (label: string) => {
		if (question === null) return;
		if (question.prompt.multiple) {
			setPicked((current) =>
				current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
			);
		} else {
			void submit(label, { outcome: "answered", selected: [label], ...note });
		}
	};

	const primary = (): [string, Reply] | null =>
		question !== null
			? picked.length > 0 || words !== ""
				? ["send", { outcome: "answered", selected: [...picked], ...note }]
				: null
			: ["approve", { outcome: "approved", ...(words === "" ? {} : { note: words }) }];

	const busy = sending !== null;

	// ⌘↵ (Ctrl↵ off Apple's keyboards) sends the main reply wherever focus is, since an ask that opens by itself has nothing
	// focused; 1-9 pick a choice while the reply box does not have focus.
	useInboxKeys((event) => {
		if (busy) return;
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			const move = primary();
			if (move === null) return;
			event.preventDefault();
			void submit(...move);
			return;
		}
		const target = event.target as HTMLElement | null;
		if (question === null || event.metaKey || event.ctrlKey) return;
		if (target?.closest("input, textarea, [contenteditable]")) return;
		const option = question.prompt.options[Number(event.key) - 1];
		if (option !== undefined) choose(option.label);
	});

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
			{error === null ? null : (
				<Banner
					role="alert"
					variant="error"
					icon={<WarningCircle />}
					title={error.title}
					description={error.description}
				/>
			)}
			{question === null || question.prompt.options.length === 0 ? null : (
				<Choices
					question={question}
					picked={picked}
					busy={busy}
					sending={sending}
					onChoose={choose}
				/>
			)}
			<InputArea
				aria-label={question === null ? "Feedback or a note" : "Your answer, or a note"}
				placeholder={
					question === null
						? "Feedback, a note to go with your approval, or a question"
						: question.prompt.options.length === 0
							? "Your answer, or a question back"
							: "Add a note, answer in your own words, or ask a question back"
				}
				value={text}
				onValueChange={setText}
				autoResize
				minRows={3}
				maxRows={12}
				disabled={busy}
			/>
			<div className="flex flex-wrap items-center gap-2">
				{question === null ? (
					<>
						<Button
							variant="primary"
							icon={<Check />}
							loading={sending === "approve"}
							disabled={busy}
							onClick={() =>
								void submit("approve", {
									outcome: "approved",
									...(words === "" ? {} : { note: words }),
								})
							}
						>
							Approve
						</Button>
						<Button
							loading={sending === "changes"}
							disabled={busy || words === ""}
							onClick={() =>
								void submit("changes", { outcome: "changes_requested", feedback: words })
							}
						>
							Request changes
						</Button>
					</>
				) : (
					<Button
						variant="primary"
						icon={<PaperPlaneRight />}
						loading={sending === "send"}
						disabled={busy || (picked.length === 0 && words === "")}
						onClick={() =>
							void submit("send", { outcome: "answered", selected: [...picked], ...note })
						}
					>
						Send
					</Button>
				)}
				<Button
					icon={<ChatTeardropText />}
					loading={sending === "ask"}
					disabled={busy || words === ""}
					onClick={() => void submit("ask", { outcome: "follow_up", question: words })}
				>
					Ask back
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
					{SEND_KEY}↵ {question === null ? "approves" : "sends"}
				</span>
			</div>
		</div>
	);
}

function Choices({
	question,
	picked,
	busy,
	sending,
	onChoose,
}: {
	readonly question: QuestionAsk;
	readonly picked: readonly string[];
	readonly busy: boolean;
	readonly sending: string | null;
	readonly onChoose: (label: string) => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			{question.prompt.options.map((option, index) => {
				const on = picked.includes(option.label);
				return (
					<button
						key={option.label}
						type="button"
						disabled={busy}
						aria-pressed={question.prompt.multiple ? on : undefined}
						onClick={() => onChoose(option.label)}
						className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${
							on
								? "border-kumo-brand bg-kumo-tint"
								: "border-kumo-line bg-kumo-base hover:bg-kumo-tint"
						}`}
					>
						<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-kumo-line text-xs text-kumo-subtle tabular-nums">
							{sending === option.label ? "…" : index + 1}
						</span>
						<span className="flex flex-col">
							<Text bold>{option.label}</Text>
							{option.description === undefined ? null : (
								<Text variant="secondary" size="sm">
									{option.description}
								</Text>
							)}
						</span>
					</button>
				);
			})}
			<Text variant="secondary" size="xs">
				{question.prompt.multiple
					? "Pick any that apply, then send."
					: "Picking a choice sends it, with any note you have typed."}
			</Text>
		</div>
	);
}

const nothing = () => {};

/** An ask the inbox could not draw, with the one move still open to the person: dismissing it. */
function CannotShow({ ask, onReplied }: { readonly ask: Ask; readonly onReplied: () => void }) {
	const { onSelect } = useNavigation();
	const send = useAtomSet(replyAtom(useClient()), { mode: "promiseExit" });
	const [sending, setSending] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	const dismiss = async () => {
		setSending(true);
		setFailed(null);
		const exit = await send({ askId: ask.id, reply: { outcome: "dismissed" } });
		setSending(false);
		if (Exit.isSuccess(exit)) {
			onReplied();
			return;
		}
		const failure = Cause.squash(exit.cause);
		setFailed(failure instanceof Error ? failure.message : "no reason given");
	};
	return (
		<article className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 md:px-8">
			<button
				type="button"
				onClick={() => onSelect(null)}
				className="inline-flex w-fit items-center gap-1 text-sm text-kumo-subtle md:hidden"
			>
				<ArrowLeft /> Inbox
			</button>
			<Banner
				variant="error"
				icon={<WarningCircle />}
				title="This ask can't be shown"
				description="It doesn't match what this inbox knows how to draw, perhaps because it was sent while Loopback was being updated. Dismiss it, and the agent can send it again."
			/>
			{failed === null ? null : (
				<Banner
					role="alert"
					variant="error"
					icon={<WarningCircle />}
					title="It was not dismissed"
					description={failed}
				/>
			)}
			{ask.status === "closed" ? null : (
				<Button
					className="w-fit"
					variant="ghost"
					icon={<X />}
					loading={sending}
					onClick={() => void dismiss()}
				>
					Dismiss
				</Button>
			)}
		</article>
	);
}

/** Keeps one ask that cannot be drawn from taking the whole inbox down with it. */
class Drawable extends Component<
	{ readonly ask: Ask; readonly onReplied: () => void; readonly children: ReactNode },
	{ readonly failed: boolean }
> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override componentDidCatch(error: unknown) {
		console.error(`Ask ${this.props.ask.id} could not be shown:`, error);
	}

	override render() {
		return this.state.failed ? (
			<CannotShow ask={this.props.ask} onReplied={this.props.onReplied} />
		) : (
			this.props.children
		);
	}
}

export function AskDetail({
	ask,
	onReplied = nothing,
}: {
	readonly ask: Ask;
	/** Called once a reply is sent: the inbox moves on to whatever is next. */
	readonly onReplied?: () => void;
}) {
	return (
		<Drawable key={ask.id} ask={ask} onReplied={onReplied}>
			<AskView ask={ask} onReplied={onReplied} />
		</Drawable>
	);
}

/** One ask: what the agent wants, the thread so far, and the moves left. */
function AskView({ ask, onReplied }: { readonly ask: Ask; readonly onReplied: () => void }) {
	const { onSelect } = useNavigation();
	const now = useNow();
	const me = useMe();
	const status = STATUS[ask.status];
	return (
		<article className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-8">
			<header className="flex flex-col gap-3">
				<button
					type="button"
					onClick={() => onSelect(null)}
					className="inline-flex w-fit items-center gap-1 text-sm text-kumo-subtle md:hidden"
				>
					<ArrowLeft /> Inbox
				</button>
				<div className="flex flex-wrap items-center gap-2 text-kumo-subtle">
					<KindIcon ask={ask} />
					<Badge variant={status.variant}>{status.label}</Badge>
					{ask.project === undefined ? null : <Badge variant="neutral">{ask.project}</Badge>}
					<Waiting ask={ask} />
					<span className="ml-auto text-xs tabular-nums">
						{ask.raisedBy?.name === undefined || ask.raisedBy.id === me
							? ""
							: `${ask.raisedBy.name}'s agent · `}
						{ask.client === undefined ? "" : `${ask.client} · `}
						{age(ask.createdAt, now)}
					</span>
				</div>
				{ask.kind === "question" ? (
					<div className="text-lg">
						<Prose text={ask.prompt.question} />
					</div>
				) : (
					<>
						<Text variant="heading" as="h1">
							{ask.prompt.title}
						</Text>
						{ask.kind !== "review" || ask.revises === undefined ? null : (
							<AskLink askId={ask.revises} className="text-sm text-kumo-link underline">
								Revises an earlier review
							</AskLink>
						)}
						{ask.prompt.summary === undefined ? null : (
							<div className="text-kumo-subtle">
								<Prose text={ask.prompt.summary} />
							</div>
						)}
					</>
				)}
			</header>

			{ask.kind === "briefing" ? (
				<BriefingBody key={ask.id} ask={ask} onReplied={onReplied} />
			) : ask.kind === "question" ? (
				ask.prompt.context === undefined ? null : (
					<details className="rounded-lg border border-kumo-line bg-kumo-base p-4">
						<summary className="cursor-pointer text-sm text-kumo-subtle">Context</summary>
						<div className="mt-3">
							<Prose text={ask.prompt.context} />
						</div>
					</details>
				)
			) : (
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-4 md:p-6">
					<Blocks blocks={ask.prompt.content} />
				</div>
			)}

			{ask.kind === "briefing" || ask.thread.length === 0 ? null : (
				<div className="flex flex-col gap-3">
					{ask.thread.map((entry) => (
						<Turn key={`${entry.author}:${entry.at}`} entry={entry} now={now} />
					))}
				</div>
			)}

			{ask.kind === "briefing" ? null : ask.status === "awaiting_human" ? (
				<ReplyPanel key={`${ask.id}:${ask.thread.length}`} ask={ask} onReplied={onReplied} />
			) : ask.status === "awaiting_agent" ? (
				<Text variant="secondary">The agent has your question and will answer here.</Text>
			) : null}
		</article>
	);
}
