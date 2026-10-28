import { Badge, Text } from "@cloudflare/kumo";
import type { Ask, InboxState } from "@loopbackhq/sdk";
import { CaretDown, CaretRight, ChatCircleDots, Eye } from "@phosphor-icons/react";
import { age, headline, useNow, useRecentOpen } from "./hooks.ts";

export function KindIcon({ ask }: { readonly ask: Ask }) {
	return ask.kind === "question" ? (
		<ChatCircleDots size={18} weight="duotone" aria-label="Question" />
	) : (
		<Eye size={18} weight="duotone" aria-label="Review" />
	);
}

/** Whether an agent is blocked on the ask right now. */
export function Waiting({ ask }: { readonly ask: Ask }) {
	if (ask.status === "closed") return null;
	return ask.waiting ? (
		<span className="inline-flex items-center gap-1.5 text-xs text-kumo-success">
			<span className="size-2 animate-pulse rounded-full bg-kumo-success" />
			Agent waiting
		</span>
	) : (
		<span className="inline-flex items-center gap-1.5 text-xs text-kumo-inactive">
			<span className="size-2 rounded-full bg-kumo-line" />
			Agent not waiting
		</span>
	);
}

function Row({
	ask,
	selected,
	now,
}: {
	readonly ask: Ask;
	readonly selected: boolean;
	readonly now: number;
}) {
	return (
		<a
			href={`#/${encodeURIComponent(ask.id)}`}
			aria-current={selected ? "page" : undefined}
			className={`flex gap-3 border-b border-kumo-hairline px-4 py-3 transition-colors hover:bg-kumo-tint ${
				selected ? "bg-kumo-tint" : ""
			}`}
		>
			<span className="mt-0.5 shrink-0 text-kumo-subtle">
				<KindIcon ask={ask} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex items-baseline gap-2">
					<Text truncate bold={ask.status === "awaiting_human"}>
						{headline(ask)}
					</Text>
					<span className="ml-auto shrink-0 text-xs text-kumo-subtle tabular-nums">
						{age(ask.closedAt ?? ask.updatedAt, now)}
					</span>
				</span>
				<span className="flex flex-wrap items-center gap-2">
					{ask.project === undefined ? null : <Badge variant="neutral">{ask.project}</Badge>}
					<Waiting ask={ask} />
				</span>
			</span>
		</a>
	);
}

const SECTION_HEADING =
	"sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-kumo-hairline bg-kumo-canvas px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-kumo-subtle";

function Section({
	title,
	asks,
	selected,
	now,
	collapse,
}: {
	readonly title: string;
	readonly asks: readonly Ask[];
	readonly selected: string | null;
	readonly now: number;
	/** Makes the section foldable: its heading opens and closes it. */
	readonly collapse?: { readonly open: boolean; readonly toggle: () => void };
}) {
	if (asks.length === 0) return null;
	const count = <span className="tabular-nums">· {asks.length}</span>;
	const open = collapse?.open ?? true;
	return (
		<section>
			{collapse === undefined ? (
				<h2 className={SECTION_HEADING}>
					{title} {count}
				</h2>
			) : (
				<h2>
					<button
						type="button"
						aria-expanded={open}
						onClick={collapse.toggle}
						className={`${SECTION_HEADING} hover:text-kumo-default`}
					>
						{open ? <CaretDown size={12} /> : <CaretRight size={12} />}
						{title} {count}
					</button>
				</h2>
			)}
			{open
				? asks.map((ask) => <Row key={ask.id} ask={ask} selected={ask.id === selected} now={now} />)
				: null}
		</section>
	);
}

/** Every ask in the inbox, grouped by whose move it is. */
export function AskList({
	inbox,
	selected,
}: {
	readonly inbox: InboxState;
	readonly selected: string | null;
}) {
	const now = useNow();
	const [recentOpen, toggleRecent] = useRecentOpen();
	const yours = inbox.open.filter((ask) => ask.status === "awaiting_human");
	const theirs = inbox.open.filter((ask) => ask.status === "awaiting_agent");
	return (
		<nav aria-label="Asks">
			{inbox.open.length === 0 ? (
				<p className="px-4 py-6 text-sm text-kumo-subtle">Nothing needs you right now.</p>
			) : null}
			<Section title="Your turn" asks={yours} selected={selected} now={now} />
			<Section title="Waiting on the agent" asks={theirs} selected={selected} now={now} />
			<Section
				title="Recent"
				asks={inbox.recent}
				selected={selected}
				now={now}
				collapse={{ open: recentOpen, toggle: toggleRecent }}
			/>
		</nav>
	);
}
