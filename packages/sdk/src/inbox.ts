import type { Ask, ServerEvent } from "@loopbackhq/protocol";

/** How many closed asks the inbox keeps, matching what a snapshot carries. */
export const RECENT_LIMIT = 50;

/** The inbox as a frontend renders it, kept current from the event socket. */
export interface InboxState {
	/**
	 * `connecting` until the first snapshot arrives, `live` while the socket is up, and
	 * `reconnecting` after it drops, until the next snapshot replaces everything.
	 */
	readonly status: "connecting" | "live" | "reconnecting";
	/** Open asks, newest first. */
	readonly open: readonly Ask[];
	/** Closed asks, most recently closed first. */
	readonly recent: readonly Ask[];
}

/** What the event stream yields: the server's frames, and the socket dropping. */
export type InboxEvent = ServerEvent | { readonly type: "disconnected" };

export const initialInbox: InboxState = { status: "connecting", open: [], recent: [] };

const newestFirst = (a: Ask, b: Ask) =>
	a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/** The inbox after one event. Pure, so any frontend can keep its own copy with it. */
export const applyEvent = (state: InboxState, event: InboxEvent): InboxState => {
	switch (event.type) {
		case "snapshot":
			return { status: "live", open: event.snapshot.open, recent: event.snapshot.recent };
		case "disconnected":
			return state.status === "connecting" ? state : { ...state, status: "reconnecting" };
		case "ask.opened":
		case "ask.updated": {
			const { ask } = event;
			const open = state.open.filter((item) => item.id !== ask.id);
			const recent = state.recent.filter((item) => item.id !== ask.id);
			return ask.status === "closed"
				? { ...state, open, recent: [ask, ...recent].slice(0, RECENT_LIMIT) }
				: { ...state, open: [...open, ask].toSorted(newestFirst), recent };
		}
	}
};

/** Open asks waiting on the person rather than on an agent. */
export const awaitingHuman = (state: InboxState): readonly Ask[] =>
	state.open.filter((ask) => ask.status === "awaiting_human");
