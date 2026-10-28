import { awaitingHuman, type Ask, type InboxState } from "@loopbackhq/sdk";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** The ask the URL points at: `#/<id>`. */
export const useSelectedAsk = (): string | null => {
	const hash = useSyncExternalStore(
		(changed) => {
			window.addEventListener("hashchange", changed);
			return () => window.removeEventListener("hashchange", changed);
		},
		() => window.location.hash,
	);
	const id = hash.replace(/^#\/?/, "");
	return id === "" ? null : decodeURIComponent(id);
};

export const select = (askId: string | null) => {
	window.location.hash = askId === null ? "" : `/${encodeURIComponent(askId)}`;
};

/**
 * The ask to open once `current` has been answered: the next one awaiting the person, below it in
 * the list, or above it if it was last. `null` when nothing else awaits them.
 */
export const nextAfter = (queue: readonly Ask[], current: string): string | null => {
	const position = queue.findIndex((ask) => ask.id === current);
	const rest = queue.filter((ask) => ask.id !== current);
	return (rest[Math.max(position, 0)] ?? rest.at(-1))?.id ?? null;
};

/**
 * The ask the inbox shows: the one the person picked, or else the top one waiting on them, so
 * something that needs them is never hidden behind a "pick one" screen.
 */
export const focusOf = (inbox: InboxState, picked: string | null): string | null =>
	picked ?? awaitingHuman(inbox)[0]?.id ?? null;

const SIDEBAR_KEY = "loopback.sidebar";

/** The inbox list's width in pixels: narrow by default, so a zoomed-in page still leaves room. */
export const SIDEBAR = { min: 220, max: 560, initial: 288 } as const;

const clampWidth = (width: number) =>
	Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width)));

/** The inbox list's width, as the person last left it in this browser. */
export const useSidebarWidth = () => {
	const [width, setWidth] = useState(() => {
		try {
			const saved = Number(localStorage.getItem(SIDEBAR_KEY));
			return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : SIDEBAR.initial;
		} catch {
			return SIDEBAR.initial;
		}
	});
	const resize = (next: number) => {
		const clamped = clampWidth(next);
		setWidth(clamped);
		try {
			localStorage.setItem(SIDEBAR_KEY, String(clamped));
		} catch {
			// Remembered for this tab only.
		}
	};
	return [width, resize] as const;
};

const RECENT_KEY = "loopback.recent";

/**
 * Whether the Recent section is open. Closed by default: what has been answered stays a click
 * away without competing with what still needs the person.
 */
export const useRecentOpen = () => {
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(RECENT_KEY) === "open";
		} catch {
			return false;
		}
	});
	const toggle = () => {
		setOpen((was) => {
			try {
				localStorage.setItem(RECENT_KEY, was ? "closed" : "open");
			} catch {
				// Remembered for this tab only.
			}
			return !was;
		});
	};
	return [open, toggle] as const;
};

/** The kind of thing an ask is, in a few words. */
export const headline = (ask: Ask): string =>
	ask.kind === "question" ? ask.prompt.question : ask.prompt.title;

/** "just now", "5 min", "3 h", "2 d". */
export const age = (iso: string, now: number): string => {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
};

/** The current time, ticking every half minute so ages stay true. */
export const useNow = (): number => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	return now;
};

const NOTIFY_KEY = "loopback.notify";

const readNotify = () => {
	try {
		return localStorage.getItem(NOTIFY_KEY) === "on";
	} catch {
		return false;
	}
};

/** Whether this browser shows a notification when an agent asks something. */
export const useNotifications = () => {
	const [enabled, setEnabled] = useState(
		() =>
			readNotify() && typeof Notification !== "undefined" && Notification.permission === "granted",
	);
	const toggle = async () => {
		const next = !enabled;
		if (next && Notification.permission !== "granted") {
			if ((await Notification.requestPermission()) !== "granted") return;
		}
		try {
			localStorage.setItem(NOTIFY_KEY, next ? "on" : "off");
		} catch {
			// Remembered for this tab only.
		}
		setEnabled(next);
	};
	return { supported: typeof Notification !== "undefined", enabled, toggle };
};

/**
 * Keeps the person's attention where it is needed: the tab title counts what awaits them, and a
 * new ask raises a notification while the tab is in the background.
 */
export const useAttention = (inbox: InboxState, notify: boolean) => {
	const seen = useRef<Set<string> | null>(null);
	const waiting = awaitingHuman(inbox);
	useEffect(() => {
		document.title = waiting.length === 0 ? "Loopback" : `(${waiting.length}) Loopback`;
	}, [waiting.length]);
	useEffect(() => {
		if (inbox.status !== "live") return;
		const ids = new Set(waiting.map((ask) => ask.id));
		const previous = seen.current;
		seen.current = ids;
		if (previous === null || !notify || !document.hidden) return;
		for (const ask of waiting) {
			if (previous.has(ask.id)) continue;
			const note = new Notification(ask.project ?? "Loopback", {
				body: headline(ask),
				tag: ask.id,
			});
			note.addEventListener("click", () => {
				window.focus();
				select(ask.id);
			});
		}
	}, [inbox.status, waiting, notify]);
};
