import { useSyncExternalStore } from "react";

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

export const hrefFor = (askId: string) => `#/${encodeURIComponent(askId)}`;

export const select = (askId: string | null) => {
	window.location.hash = askId === null ? "" : hrefFor(askId).slice(1);
};
