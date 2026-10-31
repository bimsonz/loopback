import type { Ask } from "@loopbackhq/sdk";
import { describe, expect, it } from "vitest";
import { focusOf, nextAfter } from "../src/hooks.ts";

const ask = (id: string): Ask => ({
	kind: "question",
	prompt: { question: id, options: [], multiple: false },
	id,
	status: "awaiting_human",
	waiting: false,
	thread: [],
	createdAt: "2026-10-28T10:00:00.000Z",
	updatedAt: "2026-10-28T10:00:00.000Z",
});

describe("after answering, the inbox opens", () => {
	const queue = [ask("a"), ask("b"), ask("c")];

	it("the ask below the one answered", () => {
		expect(nextAfter(queue, "a")).toBe("b");
		expect(nextAfter(queue, "b")).toBe("c");
	});

	it("the one above when the answered ask was last", () => {
		expect(nextAfter(queue, "c")).toBe("b");
	});

	it("the first waiting ask when the answered one had already left the list", () => {
		expect(nextAfter(queue, "gone")).toBe("a");
	});

	it("nothing when nothing else awaits the person", () => {
		expect(nextAfter([ask("a")], "a")).toBeNull();
		expect(nextAfter([], "a")).toBeNull();
	});
});

describe("the inbox shows", () => {
	const live = (open: Ask[]) => ({ status: "live" as const, open, recent: [] });

	it("the ask the person picked", () => {
		expect(focusOf(live([ask("a"), ask("b")]), "b")).toBe("b");
	});

	it("the top waiting ask when nothing is picked", () => {
		expect(focusOf(live([ask("a"), ask("b")]), null)).toBe("a");
	});

	it("nothing when nothing is picked or waiting", () => {
		expect(focusOf(live([]), null)).toBeNull();
		expect(focusOf(live([{ ...ask("a"), status: "awaiting_agent" }]), null)).toBeNull();
	});
});
