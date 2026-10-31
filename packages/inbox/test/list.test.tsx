import { type Ask, type InboxState, numberBriefing } from "@loopbackhq/sdk";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AskList } from "../src/list.tsx";
import { Host } from "./host.tsx";

const ask = (id: string, status: Ask["status"]): Ask => ({
	kind: "question",
	prompt: { question: `Question ${id}?`, options: [], multiple: false },
	id,
	status,
	waiting: false,
	project: "loopback",
	thread: [],
	createdAt: "2026-10-28T10:00:00.000Z",
	updatedAt: "2026-10-28T10:00:00.000Z",
});

const inbox = (open: Ask[], recent: Ask[]): InboxState => ({ status: "live", open, recent });

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("the ask list", () => {
	it("keeps answered asks folded away until asked for", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<AskList
				inbox={inbox([ask("mine", "awaiting_human")], [ask("done", "closed")])}
				selected={null}
			/>,
			{ wrapper: Host },
		);
		expect(screen.getByText("Question mine?")).toBeInTheDocument();
		const recent = screen.getByRole("button", { name: /Recent/ });
		expect(recent).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Question done?")).toBeNull();

		await user.click(recent);
		expect(screen.getByText("Question done?")).toBeInTheDocument();

		rerender(
			<AskList
				inbox={inbox([ask("mine", "awaiting_human")], [ask("done", "closed")])}
				selected={null}
			/>,
		);
		expect(screen.getByRole("button", { name: /Recent/ })).toHaveAttribute("aria-expanded", "true");
	});

	it("says so when nothing needs the person", () => {
		render(<AskList inbox={inbox([], [ask("done", "closed")])} selected={null} />, {
			wrapper: Host,
		});
		expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
	});

	it("shows how many points of a briefing need the person", () => {
		const briefing: Ask = {
			...ask("b", "awaiting_human"),
			kind: "briefing",
			prompt: numberBriefing({
				title: "What changes",
				sections: [{ points: [{ title: "One" }, { title: "Two" }] }],
			}),
		};
		render(<AskList inbox={inbox([briefing], [])} selected={null} />, { wrapper: Host });
		expect(screen.getByText("What changes")).toBeInTheDocument();
		expect(screen.getByText("2 need you")).toBeInTheDocument();
	});
});
