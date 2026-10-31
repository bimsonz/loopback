import type {
	Actor,
	AgentEntry,
	Block,
	BriefingInput,
	BriefingPoint,
	BriefingPrompt,
	Entry,
	Point,
	PointAnswer,
	Responded,
} from "./generated/requests.gen.ts";

// A briefing's points, and where each stands, are never stored: they are folded from its prompt and
// its thread. The server validates with this fold and every frontend renders with it, so the two
// cannot disagree about what a reply means.

/** The most top-level points a briefing may hold. */
export const MAX_TOP_POINTS = 50;

/** How deep sub-points may go: `3.1.2` is as deep as it gets. */
export const MAX_POINT_DEPTH = 3;

/**
 * Where a point stands. It needs the person while they have not touched it or the agent answered it
 * last; it is with the agent while the agent owes an answer on it; it is open when touched with
 * nothing pending, as a resolved point is once something beneath it is written on again.
 */
export type PointState = "needs_you" | "with_agent" | "open" | "resolved";

/** One turn on one point: the person's words or resolve, or the agent's answer. */
export type PointTurn =
	| {
			readonly author: "human";
			readonly text?: string;
			readonly resolved: boolean;
			readonly by?: Actor;
			readonly at: string;
	  }
	| {
			readonly author: "agent";
			readonly answer: string;
			readonly content?: readonly Block[];
			readonly at: string;
	  };

/** A point as it stands, with its own turns and its sub-points. */
export interface PointNode {
	readonly id: string;
	readonly title: string;
	readonly detail?: string;
	readonly content?: readonly Block[];
	/** 1 for a top-level point, 2 beneath it, and so on. */
	readonly depth: number;
	readonly state: PointState;
	readonly turns: readonly PointTurn[];
	readonly points: readonly PointNode[];
	/** How many points, this one and those beneath it, need the person. */
	readonly needsYou: number;
	/**
	 * The thread entry, counting from 1, that last resolved this point, itself or from above; 0 if
	 * none ever did. Anything the person drafted before it was written before the point was settled.
	 */
	readonly resolvedAtEntry: number;
}

/** A briefing as it stands. */
export interface BriefingTree {
	readonly sections: readonly {
		readonly title?: string;
		readonly points: readonly PointNode[];
	}[];
	/** The points the agent owes an answer on, in the order they are read. */
	readonly owed: readonly string[];
	readonly needsYou: number;
	/** Whether every point, at every depth, is resolved: then the briefing is over. */
	readonly resolved: boolean;
}

/** Whether a reply says anything: text that is more than whitespace. */
export const hasWords = (text: string | undefined): boolean =>
	text !== undefined && text.trim() !== "";

const pointOf = (id: string, point: BriefingPoint): Point => ({
	id,
	title: point.title,
	...(point.detail === undefined ? {} : { detail: point.detail }),
	...(point.content === undefined ? {} : { content: point.content }),
});

/** A briefing as it opens: its top-level points numbered straight through every section. */
export const numberBriefing = (
	input: Pick<BriefingInput, "title" | "summary" | "sections">,
): BriefingPrompt => {
	let next = 0;
	return {
		title: input.title,
		...(input.summary === undefined ? {} : { summary: input.summary }),
		sections: input.sections.map((section) => ({
			...(section.title === undefined ? {} : { title: section.title }),
			points: section.points.map((point) => pointOf(String((next += 1)), point)),
		})),
	};
};

/** A point while the fold is building it. */
interface Building {
	readonly point: Point;
	readonly depth: number;
	readonly parent: Building | undefined;
	readonly turns: PointTurn[];
	readonly children: Building[];
	resolved: boolean;
	resolvedAtEntry: number;
}

const resolveAll = (node: Building, entry: number) => {
	node.resolved = true;
	node.resolvedAtEntry = entry;
	for (const child of node.children) resolveAll(child, entry);
};

/** Whether a point is, or sits beneath, one of these. */
const within = (node: Building, among: ReadonlySet<Building>): boolean => {
	for (let at: Building | undefined = node; at !== undefined; at = at.parent) {
		if (among.has(at)) return true;
	}
	return false;
};

const reopen = (node: Building | undefined) => {
	for (let at = node; at !== undefined; at = at.parent) at.resolved = false;
};

const stateOf = (node: Building): PointState => {
	if (node.resolved) return "resolved";
	const last = node.turns.at(-1);
	if (last === undefined || last.author === "agent") return "needs_you";
	// Words sent with a resolve are a closing note: even once the point is reopened from below,
	// nothing is owed on them.
	return hasWords(last.text) && !last.resolved ? "with_agent" : "open";
};

const finish = (node: Building): PointNode => {
	const points = node.children.map(finish);
	const state = stateOf(node);
	return {
		...node.point,
		depth: node.depth,
		state,
		turns: node.turns,
		points,
		needsYou: (state === "needs_you" ? 1 : 0) + points.reduce((sum, p) => sum + p.needsYou, 0),
		resolvedAtEntry: node.resolvedAtEntry,
	};
};

/** Every point, in the order it is read: each followed by everything beneath it. */
const inOrder = (points: readonly PointNode[]): PointNode[] =>
	points.flatMap((point) => [point, ...inOrder(point.points)]);

/** The briefing as its thread leaves it. Entries naming a point it does not have change nothing. */
export const foldBriefing = (prompt: BriefingPrompt, thread: readonly Entry[]): BriefingTree => {
	const byId = new Map<string, Building>();
	const add = (point: Point, parent: Building | undefined): Building => {
		const node: Building = {
			point,
			depth: parent === undefined ? 1 : parent.depth + 1,
			parent,
			turns: [],
			children: [],
			resolved: false,
			resolvedAtEntry: 0,
		};
		byId.set(point.id, node);
		parent?.children.push(node);
		return node;
	};
	const sections = prompt.sections.map((section) => ({
		title: section.title,
		points: section.points.map((point) => add(point, undefined)),
	}));
	for (const [index, entry] of thread.entries()) {
		if (entry.author === "human") {
			if (entry.reply.outcome !== "responded") continue;
			// Resolving wins, whatever order a reply lists its points in: words on or beneath a point
			// resolved in the same reply are closing notes, and reopen nothing.
			const resolving = new Set(
				entry.reply.points.flatMap((item) => {
					const node = item.resolved === true ? byId.get(item.point) : undefined;
					return node === undefined ? [] : [node];
				}),
			);
			for (const item of entry.reply.points) {
				const node = byId.get(item.point);
				if (node === undefined) continue;
				const settled = within(node, resolving);
				node.turns.push({
					author: "human",
					...(item.text === undefined ? {} : { text: item.text }),
					resolved: settled,
					...(entry.by === undefined ? {} : { by: entry.by }),
					at: entry.at,
				});
				if (!settled && hasWords(item.text)) reopen(node);
			}
			for (const node of resolving) resolveAll(node, index + 1);
		} else {
			const node = entry.point === undefined ? undefined : byId.get(entry.point);
			if (node === undefined) continue;
			node.turns.push({
				author: "agent",
				answer: entry.answer,
				...(entry.content === undefined ? {} : { content: entry.content }),
				at: entry.at,
			});
			for (const point of entry.points ?? []) add(point, node);
		}
	}
	const finished = sections.map((section) => ({
		...(section.title === undefined ? {} : { title: section.title }),
		points: section.points.map(finish),
	}));
	const all = inOrder(finished.flatMap((section) => section.points));
	return {
		sections: finished,
		owed: all.filter((point) => point.state === "with_agent").map((point) => point.id),
		needsYou: all.reduce((sum, point) => sum + (point.state === "needs_you" ? 1 : 0), 0),
		resolved: all.every((point) => point.state === "resolved"),
	};
};

/** A point of the briefing by its id, at any depth. */
export const findPoint = (tree: BriefingTree, id: string): PointNode | undefined =>
	inOrder(tree.sections.flatMap((section) => section.points)).find((point) => point.id === id);

/** "2", "2 and 3.1", "2, 3 and 3.1". */
const listed = (ids: readonly string[]): string =>
	ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;

/**
 * Why the person's reply does not fit the briefing, or null when it does. Each item names a point
 * the briefing has, once, with words or resolved; and the reply either resolves every point or
 * leaves the agent something to answer.
 */
export const respondedProblem = (
	prompt: BriefingPrompt,
	thread: readonly Entry[],
	reply: Responded,
): string | null => {
	const tree = foldBriefing(prompt, thread);
	const seen = new Set<string>();
	for (const item of reply.points) {
		if (findPoint(tree, item.point) === undefined) return `No point "${item.point}".`;
		if (seen.has(item.point)) return `Point ${item.point} appears twice.`;
		seen.add(item.point);
		if (!hasWords(item.text) && item.resolved !== true) {
			return `Say something on point ${item.point}, or mark it resolved.`;
		}
	}
	const after = foldBriefing(prompt, [...thread, { author: "human", reply, at: "" }]);
	if (after.resolved || after.owed.length > 0) return null;
	const open = inOrder(after.sections.flatMap((section) => section.points))
		.filter((point) => point.state !== "resolved")
		.map((point) => point.id);
	const shown = open.length > 6 ? [...open.slice(0, 5), `${open.length - 5} more`] : open;
	return `Nothing here for the agent to answer: write on a point, or resolve every point to finish (${listed(shown)} ${open.length === 1 ? "is" : "are"} still open).`;
};

/**
 * Why the agent's move does not fit the briefing, or null when it does. Each answer names an open
 * point, once; sub-points go no deeper than `MAX_POINT_DEPTH`; and every owed point is answered.
 */
export const answersProblem = (
	tree: BriefingTree,
	answers: readonly PointAnswer[],
): string | null => {
	const seen = new Set<string>();
	for (const answer of answers) {
		const point = findPoint(tree, answer.point);
		if (point === undefined) return `No point "${answer.point}".`;
		if (seen.has(answer.point)) return `Point ${answer.point} appears twice.`;
		seen.add(answer.point);
		if (point.state === "resolved") {
			return `Point ${answer.point} is resolved: the person is done with it.`;
		}
		if ((answer.points?.length ?? 0) > 0 && point.depth >= MAX_POINT_DEPTH) {
			return `Point ${answer.point} is as deep as points go: answer it without sub-points.`;
		}
	}
	const missing = tree.owed.filter((id) => !seen.has(id));
	return missing.length === 0
		? null
		: `Answer every point the person wrote on: ${listed(missing)} ${missing.length === 1 ? "is" : "are"} missing.`;
};

/**
 * The thread entries an agent's move becomes: one per answer, with any sub-points numbered on from
 * those the point already has. The move must already fit (see `answersProblem`).
 */
export const answerEntries = (
	tree: BriefingTree,
	answers: readonly PointAnswer[],
	at: string,
): AgentEntry[] =>
	answers.map((answer) => {
		const had = findPoint(tree, answer.point)?.points.length ?? 0;
		const points = (answer.points ?? []).map((point, index) =>
			pointOf(`${answer.point}.${had + index + 1}`, point),
		);
		return {
			author: "agent",
			answer: answer.answer,
			...(answer.content === undefined ? {} : { content: answer.content }),
			point: answer.point,
			...(points.length === 0 ? {} : { points }),
			at,
		};
	});
