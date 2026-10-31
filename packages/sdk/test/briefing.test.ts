import type { Entry, PointAnswer, PointReply } from "@loopbackhq/protocol";
import { describe, expect, it } from "vitest";
import {
	answerEntries,
	answersProblem,
	type BriefingTree,
	findPoint,
	foldBriefing,
	numberBriefing,
	type PointNode,
	respondedProblem,
} from "../src/index.ts";

const prompt = numberBriefing({
	title: "What the migration changes",
	sections: [
		{
			title: "Storage",
			points: [
				{ title: "Sessions move to D1", detail: "Out of KV." },
				{ title: "R2 keeps images" },
			],
		},
		{ title: "Auth", points: [{ title: "Tokens are hashed at rest" }] },
	],
});

let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 30, 12, 0, clock++)).toISOString();

const said = (...points: PointReply[]): Entry => ({
	author: "human",
	reply: { outcome: "responded", points },
	at: at(),
});

/** The agent's move as the space records it: one entry per answer, sub-points numbered. */
const answered = (thread: readonly Entry[], ...answers: PointAnswer[]): Entry[] => [
	...thread,
	...answerEntries(foldBriefing(prompt, thread), answers, at()),
];

const point = (tree: BriefingTree, id: string): PointNode => {
	const found = findPoint(tree, id);
	if (found === undefined) throw new Error(`No point ${id}`);
	return found;
};

const states = (tree: BriefingTree, ...ids: string[]) => ids.map((id) => point(tree, id).state);

/** Point 1 written on and answered with two sub-points, 1.1 and 1.2. */
const withSubPoints = (): Entry[] =>
	answered([said({ point: "1", text: "Why D1?" })], {
		point: "1",
		answer: "Two reasons.",
		points: [{ title: "Queries across sessions" }, { title: "One less binding" }],
	});

describe("a briefing's points", () => {
	it("numbers top-level points straight through its sections", () => {
		expect(prompt.sections.map((section) => section.points.map((p) => p.id))).toEqual([
			["1", "2"],
			["3"],
		]);
		expect(prompt.sections[0]?.points[0]).toEqual({
			id: "1",
			title: "Sessions move to D1",
			detail: "Out of KV.",
		});
	});

	it("starts with every point needing the person", () => {
		const tree = foldBriefing(prompt, []);
		expect(tree.needsYou).toBe(3);
		expect(tree.owed).toEqual([]);
		expect(tree.resolved).toBe(false);
		expect(states(tree, "1", "2", "3")).toEqual(["needs_you", "needs_you", "needs_you"]);
	});

	it("owes an answer on words, not on resolving", () => {
		const tree = foldBriefing(prompt, [
			said(
				{ point: "1", text: "Why?" },
				{ point: "2", resolved: true },
				{ point: "3", text: "Fine by me", resolved: true },
			),
		]);
		expect(tree.owed).toEqual(["1"]);
		expect(states(tree, "1", "2", "3")).toEqual(["with_agent", "resolved", "resolved"]);
		expect(tree.needsYou).toBe(0);
	});

	it("hands a point back once the agent answers, with its sub-points", () => {
		const tree = foldBriefing(prompt, withSubPoints());
		expect(point(tree, "1").points.map((p) => [p.id, p.title, p.depth])).toEqual([
			["1.1", "Queries across sessions", 2],
			["1.2", "One less binding", 2],
		]);
		expect(states(tree, "1", "1.1", "1.2")).toEqual(["needs_you", "needs_you", "needs_you"]);
		expect(point(tree, "1").needsYou).toBe(3);
		expect(point(tree, "1").turns.map((turn) => turn.author)).toEqual(["human", "agent"]);
		expect(tree.owed).toEqual([]);
	});

	it("continues numbering when sub-points are added again", () => {
		const first = withSubPoints();
		const thread = answered([...first, said({ point: "1", text: "And a third?" })], {
			point: "1",
			answer: "Yes.",
			points: [{ title: "Backups" }],
		});
		expect(point(foldBriefing(prompt, thread), "1").points.map((p) => p.id)).toEqual([
			"1.1",
			"1.2",
			"1.3",
		]);
	});

	it("resolves everything beneath a resolved point", () => {
		const tree = foldBriefing(prompt, [...withSubPoints(), said({ point: "1", resolved: true })]);
		expect(states(tree, "1", "1.1", "1.2")).toEqual(["resolved", "resolved", "resolved"]);
	});

	it("reopens the ancestors of a point written on, and nothing else", () => {
		const tree = foldBriefing(prompt, [
			...withSubPoints(),
			said({ point: "1", resolved: true }),
			said({ point: "1.1", text: "Wait, which queries?" }),
		]);
		expect(point(tree, "1.1").state).toBe("with_agent");
		expect(point(tree, "1").state).toBe("open");
		expect(point(tree, "1.2").state).toBe("resolved");
		expect(tree.owed).toEqual(["1.1"]);
	});

	it("owes nothing on a closing note when a point is reopened from below", () => {
		const tree = foldBriefing(prompt, [
			...withSubPoints(),
			said({ point: "1", text: "ok thanks", resolved: true }),
			said({ point: "1.1", text: "Wait, which queries?" }),
		]);
		expect(tree.owed).toEqual(["1.1"]);
		expect(point(tree, "1").state).toBe("open");
	});

	it("lets resolving win whatever the order of a reply's items", () => {
		const base = withSubPoints();
		for (const items of [
			[
				{ point: "1", resolved: true },
				{ point: "1.1", text: "Noted." },
			],
			[
				{ point: "1.1", text: "Noted." },
				{ point: "1", resolved: true },
			],
		]) {
			const tree = foldBriefing(prompt, [...base, said(...items)]);
			expect(states(tree, "1", "1.1", "1.2")).toEqual(["resolved", "resolved", "resolved"]);
			expect(tree.owed).toEqual([]);
		}
	});

	it("keeps words beneath a point resolved in the same reply as closing notes", () => {
		const deeper = answered([...withSubPoints(), said({ point: "1.1", text: "More?" })], {
			point: "1.1",
			answer: "Yes.",
			points: [{ title: "Joins" }],
		});
		const tree = foldBriefing(prompt, [
			...deeper,
			said({ point: "1.1", text: "Noted, fine." }, { point: "1", resolved: true }),
			said({ point: "1.1.1", text: "Wait…" }),
		]);
		expect(tree.owed).toEqual(["1.1.1"]);
		expect(point(tree, "1.1").state).toBe("open");
	});

	it("reopens nothing above a point resolved in the same reply", () => {
		const deeper = answered([...withSubPoints(), said({ point: "1.1", text: "More?" })], {
			point: "1.1",
			answer: "Yes.",
			points: [{ title: "Joins" }],
		});
		const tree = foldBriefing(prompt, [
			...deeper,
			said({ point: "1", resolved: true }),
			said(
				{ point: "1.1.1", text: "hmm" },
				{ point: "1.1", resolved: true },
				{ point: "2", text: "and?" },
			),
		]);
		expect(states(tree, "1", "1.1", "1.1.1")).toEqual(["resolved", "resolved", "resolved"]);
	});

	it("records which entry last resolved a point, itself or from above", () => {
		const thread = [...withSubPoints(), said({ point: "1", resolved: true })];
		const tree = foldBriefing(prompt, thread);
		expect(point(tree, "1").resolvedAtEntry).toBe(3);
		expect(point(tree, "1.2").resolvedAtEntry).toBe(3);
		expect(point(tree, "2").resolvedAtEntry).toBe(0);
		const reopened = foldBriefing(prompt, [...thread, said({ point: "1.1", text: "Wait" })]);
		expect(point(reopened, "1").resolvedAtEntry).toBe(3);
	});

	it("is resolved only when every point at every depth is", () => {
		const thread = [
			...withSubPoints(),
			said({ point: "2", resolved: true }, { point: "3", resolved: true }),
		];
		expect(foldBriefing(prompt, thread).resolved).toBe(false);
		const done = [
			...thread,
			said({ point: "1.1", resolved: true }, { point: "1.2", resolved: true }),
		];
		expect(foldBriefing(prompt, done).resolved).toBe(false);
		expect(foldBriefing(prompt, [...done, said({ point: "1", resolved: true })]).resolved).toBe(
			true,
		);
	});
});

describe("a reply on a briefing", () => {
	const problem = (...points: PointReply[]) =>
		respondedProblem(prompt, [], { outcome: "responded", points });

	it("names a point the briefing does not have", () => {
		expect(problem({ point: "9", text: "?" })).toBe('No point "9".');
	});

	it("names a point given twice", () => {
		expect(problem({ point: "2", text: "a" }, { point: "2", resolved: true })).toBe(
			"Point 2 appears twice.",
		);
	});

	it("takes whitespace for saying nothing", () => {
		expect(problem({ point: "2", text: "   " })).toBe(
			"Say something on point 2, or mark it resolved.",
		);
	});

	it("must leave the agent something to answer, unless it resolves everything", () => {
		expect(problem({ point: "2", resolved: true })).toBe(
			"Nothing here for the agent to answer: write on a point, or resolve every point to finish (1 and 3 are still open).",
		);
		expect(
			problem(
				{ point: "1", resolved: true },
				{ point: "2", resolved: true },
				{ point: "3", text: "Last word", resolved: true },
			),
		).toBeNull();
		expect(problem({ point: "1", text: "Why?" })).toBeNull();
	});
});

describe("the agent's answers on a briefing", () => {
	const owing = foldBriefing(prompt, [
		...withSubPoints(),
		said({ point: "2", text: "Which bucket?" }, { point: "1.1", text: "Such as?" }),
	]);

	it("lists every owed point left out", () => {
		expect(answersProblem(owing, [{ point: "3", answer: "Also this." }])).toBe(
			"Answer every point the person wrote on: 1.1 and 2 are missing.",
		);
	});

	it("refuses a resolved point, and sub-points under one", () => {
		const tree = foldBriefing(prompt, [
			said({ point: "1", text: "Why?" }, { point: "3", resolved: true }),
		]);
		expect(
			answersProblem(tree, [
				{ point: "1", answer: "Because." },
				{ point: "3", answer: "More." },
			]),
		).toBe("Point 3 is resolved: the person is done with it.");
	});

	it("refuses an unknown point and a point answered twice", () => {
		const tree = foldBriefing(prompt, [said({ point: "1", text: "Why?" })]);
		expect(answersProblem(tree, [{ point: "1.4", answer: "?" }])).toBe('No point "1.4".');
		expect(
			answersProblem(tree, [
				{ point: "1", answer: "a" },
				{ point: "1", answer: "b" },
			]),
		).toBe("Point 1 appears twice.");
	});

	it("goes no deeper than three levels", () => {
		let thread = withSubPoints();
		thread = answered([...thread, said({ point: "1.1", text: "More?" })], {
			point: "1.1",
			answer: "Yes.",
			points: [{ title: "Joins" }],
		});
		const tree = foldBriefing(prompt, [...thread, said({ point: "1.1.1", text: "Deeper?" })]);
		expect(point(tree, "1.1.1").depth).toBe(3);
		expect(
			answersProblem(tree, [{ point: "1.1.1", answer: "No.", points: [{ title: "Too deep" }] }]),
		).toBe("Point 1.1.1 is as deep as points go: answer it without sub-points.");
	});

	it("accepts a move that answers every owed point", () => {
		expect(
			answersProblem(owing, [
				{ point: "2", answer: "The images bucket." },
				{ point: "1.1", answer: "Counting active sessions." },
			]),
		).toBeNull();
	});
});
