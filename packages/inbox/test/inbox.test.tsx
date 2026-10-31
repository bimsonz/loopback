import { RegistryProvider } from "@effect/atom-react";
import type { Actor, Ask, InboxState, LoopbackApi, Reply } from "@loopbackhq/sdk";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Inbox, type InboxNavigation, InboxProvider } from "../src/index.ts";

const ADA: Actor = { id: "person-1", name: "Ada" };
const BEA: Actor = { id: "person-2", name: "Bea" };

const question = (id: string, text: string, raisedBy?: Actor): Ask => ({
	kind: "question",
	prompt: { question: text, options: [{ label: "Yes" }, { label: "No" }], multiple: false },
	id,
	status: "awaiting_human",
	waiting: true,
	project: "loopback",
	thread: [],
	createdAt: "2026-10-31T10:00:00.000Z",
	updatedAt: "2026-10-31T10:00:00.000Z",
	...(raisedBy === undefined ? {} : { raisedBy }),
});

/** A space as a client sees it: its asks, held live, and the replies sent to it. */
const space = (me: Actor, open: Ask[]) => {
	const replies: { askId: string; reply: Reply }[] = [];
	const state: InboxState = { status: "live", open, recent: [] };
	const client: LoopbackApi = {
		whoami: Effect.succeed({ space: "acme", actor: me }),
		snapshot: Effect.die("unused"),
		ask: () => Effect.die("unused"),
		history: () => Effect.die("unused"),
		reply: (askId, reply) =>
			Effect.sync(() => {
				replies.push({ askId, reply });
				return { ...open.find((ask) => ask.id === askId)!, status: "closed" as const };
			}),
		file: () => Effect.die("unused"),
		events: Stream.empty,
		inbox: Stream.make(state).pipe(Stream.concat(Stream.never)),
	};
	return { client, replies };
};

const navigation = (selectedId: string | null = null) => ({
	selectedId,
	onSelect: vi.fn<InboxNavigation["onSelect"]>(),
	hrefFor: (askId: string) => `/w/acme/asks/${askId}`,
});

const show = (client: LoopbackApi, nav: InboxNavigation) =>
	render(
		<RegistryProvider>
			<InboxProvider client={client}>
				<button type="button">The host's own button</button>
				<div style={{ height: 600 }}>
					<Inbox {...nav} />
				</div>
			</InboxProvider>
		</RegistryProvider>,
	);

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("an inbox inside a host's app", () => {
	it("opens an ask through the host's navigation, leaving new tabs to the browser", async () => {
		const user = userEvent.setup();
		const nav = navigation();
		const { client } = space(ADA, [question("q1", "First?", ADA), question("q2", "Second?", ADA)]);
		show(client, nav);
		const row = await screen.findByRole("link", { name: /Second\?/ });
		expect(row).toHaveAttribute("href", "/w/acme/asks/q2");

		await user.click(row);
		expect(nav.onSelect).toHaveBeenLastCalledWith("q2");
		expect(window.location.hash).toBe("");

		nav.onSelect.mockClear();
		await user.keyboard("{Control>}");
		await user.click(row);
		await user.keyboard("{/Control}");
		expect(nav.onSelect).not.toHaveBeenCalled();
	});

	it("moves on through the host once an ask is answered", async () => {
		const user = userEvent.setup();
		const nav = navigation("q1");
		const { client, replies } = space(ADA, [
			question("q1", "First?", ADA),
			question("q2", "Second?", ADA),
		]);
		show(client, nav);
		await screen.findAllByText("First?");
		await user.keyboard("1");
		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toEqual({
			askId: "q1",
			reply: { outcome: "answered", selected: ["Yes"] },
		});
		await waitFor(() => expect(nav.onSelect).toHaveBeenLastCalledWith("q2"));
	});

	it("leaves keys pressed in the host's own controls to the host", async () => {
		const user = userEvent.setup();
		const { client, replies } = space(ADA, [question("q1", "First?", ADA)]);
		show(client, navigation("q1"));
		await screen.findAllByText("First?");

		act(() => screen.getByRole("button", { name: "The host's own button" }).focus());
		await user.keyboard("1");
		await user.keyboard("{Meta>}{Enter}{/Meta}");
		expect(replies).toEqual([]);

		act(() => (document.activeElement as HTMLElement).blur());
		await user.keyboard("1");
		await waitFor(() => expect(replies).toHaveLength(1));
	});
});

describe("a space several people's agents ask in", () => {
	it("lets the person narrow the list to their own agents' asks", async () => {
		const user = userEvent.setup();
		const { client } = space(ADA, [
			question("q1", "Ada's agent asks?", ADA),
			question("q2", "Bea's agent asks?", BEA),
		]);
		show(client, navigation());
		const asks = await screen.findByRole("navigation", { name: "Asks" });
		await within(asks).findByText("Bea's agent asks?");

		await user.click(screen.getByRole("tab", { name: "My agents'" }));
		expect(within(asks).getByText("Ada's agent asks?")).toBeInTheDocument();
		expect(within(asks).queryByText("Bea's agent asks?")).toBeNull();

		await user.click(screen.getByRole("tab", { name: "Everyone's" }));
		expect(within(asks).getByText("Bea's agent asks?")).toBeInTheDocument();
	});

	it("offers no choice where only the person's own agents ask", async () => {
		const { client } = space(ADA, [question("q1", "Mine?", ADA), question("q2", "Older?")]);
		show(client, navigation());
		await screen.findAllByText("Mine?");
		expect(screen.queryByRole("tab")).toBeNull();
	});
});

describe("switching spaces", () => {
	it("follows the client the host hands over, and nothing of the last one", async () => {
		const acme = space(ADA, [question("a1", "Acme's ask?", ADA)]);
		const globex = space(ADA, [question("g1", "Globex's ask?", ADA)]);
		const nav = navigation();
		const view = (client: LoopbackApi) => (
			<RegistryProvider>
				<InboxProvider client={client}>
					<Inbox {...nav} />
				</InboxProvider>
			</RegistryProvider>
		);
		const { rerender } = render(view(acme.client));
		const asks = await screen.findByRole("navigation", { name: "Asks" });
		await within(asks).findByText("Acme's ask?");

		rerender(view(globex.client));
		await within(await screen.findByRole("navigation", { name: "Asks" })).findByText(
			"Globex's ask?",
		);
		expect(screen.queryByText("Acme's ask?")).toBeNull();
	});
});
