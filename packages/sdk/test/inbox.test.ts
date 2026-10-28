import type { Ask } from "@loopbackhq/protocol";
import { describe, expect, it } from "vitest";
import { applyEvent, awaitingHuman, initialInbox, RECENT_LIMIT } from "../src/index.ts";

const ask = (id: string, createdAt: string, status: Ask["status"] = "awaiting_human"): Ask => ({
	kind: "question",
	prompt: { question: `Question ${id}?`, options: [], multiple: false },
	id,
	status,
	waiting: false,
	thread: [],
	createdAt,
	updatedAt: createdAt,
});

describe("the inbox", () => {
	it("starts from a snapshot", () => {
		const state = applyEvent(initialInbox, {
			type: "snapshot",
			snapshot: { open: [ask("a", "2026-01-02")], recent: [ask("b", "2026-01-01", "closed")] },
		});
		expect(state.status).toBe("live");
		expect(state.open.map((item) => item.id)).toEqual(["a"]);
		expect(state.recent.map((item) => item.id)).toEqual(["b"]);
	});

	it("keeps open asks newest first, and moves closed ones to recent", () => {
		let state = applyEvent(initialInbox, { type: "snapshot", snapshot: { open: [], recent: [] } });
		state = applyEvent(state, { type: "ask.opened", ask: ask("old", "2026-01-01") });
		state = applyEvent(state, { type: "ask.opened", ask: ask("new", "2026-01-03") });
		state = applyEvent(state, {
			type: "ask.updated",
			ask: { ...ask("old", "2026-01-01"), waiting: true },
		});
		expect(state.open.map((item) => item.id)).toEqual(["new", "old"]);
		expect(state.open[1]?.waiting).toBe(true);
		state = applyEvent(state, { type: "ask.updated", ask: ask("new", "2026-01-03", "closed") });
		expect(state.open.map((item) => item.id)).toEqual(["old"]);
		expect(state.recent.map((item) => item.id)).toEqual(["new"]);
	});

	it("keeps only the most recent closed asks", () => {
		let state = applyEvent(initialInbox, { type: "snapshot", snapshot: { open: [], recent: [] } });
		for (let index = 0; index <= RECENT_LIMIT; index += 1) {
			state = applyEvent(state, {
				type: "ask.updated",
				ask: ask(`c${index}`, "2026-01-01", "closed"),
			});
		}
		expect(state.recent).toHaveLength(RECENT_LIMIT);
		expect(state.recent[0]?.id).toBe(`c${RECENT_LIMIT}`);
	});

	it("marks a dropped connection until the next snapshot", () => {
		const live = applyEvent(initialInbox, { type: "snapshot", snapshot: { open: [], recent: [] } });
		expect(applyEvent(live, { type: "disconnected" }).status).toBe("reconnecting");
		expect(applyEvent(initialInbox, { type: "disconnected" }).status).toBe("connecting");
	});

	it("tells asks awaiting the person from those awaiting an agent", () => {
		const state = applyEvent(initialInbox, {
			type: "snapshot",
			snapshot: {
				open: [ask("mine", "2026-01-02"), ask("theirs", "2026-01-01", "awaiting_agent")],
				recent: [],
			},
		});
		expect(awaitingHuman(state).map((item) => item.id)).toEqual(["mine"]);
	});
});
