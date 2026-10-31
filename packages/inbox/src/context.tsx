import { useAtomValue } from "@effect/atom-react";
import { initialInbox, type InboxState, type LoopbackApi } from "@loopbackhq/sdk";
import { AsyncResult } from "effect/reactivity";
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	type RefObject,
	use,
	useEffect,
} from "react";
import { inboxAtom } from "./state.ts";

const ClientContext = createContext<LoopbackApi | null>(null);

/**
 * Gives everything inside it the client the inbox reads and answers through. Hand over another
 * client, for another space or another person, and the inbox follows that one instead.
 */
export function InboxProvider({
	client,
	children,
}: {
	readonly client: LoopbackApi;
	readonly children: ReactNode;
}) {
	return <ClientContext value={client}>{children}</ClientContext>;
}

/** The client the nearest `InboxProvider` holds. */
export const useClient = (): LoopbackApi => {
	const client = use(ClientContext);
	if (client === null) throw new Error("Loopback's inbox renders inside an <InboxProvider>.");
	return client;
};

/** The inbox as it stands, kept live while anything renders it. */
export const useInbox = (): InboxState =>
	AsyncResult.getOrElse(useAtomValue(inboxAtom(useClient())), () => initialInbox);

/** Where the inbox moves between asks: in the host's own routes, or anywhere else it likes. */
export interface InboxNavigation {
	/** The ask the person opened, or `null` for none. */
	readonly selectedId: string | null;
	/** Opens an ask, or with `null` goes back to the list. */
	readonly onSelect: (askId: string | null) => void;
	/** The address of an ask, for links opened in a new tab. */
	readonly hrefFor: (askId: string) => string;
}

export const NavigationContext = createContext<InboxNavigation | null>(null);

export const useNavigation = (): InboxNavigation => {
	const navigation = use(NavigationContext);
	if (navigation === null) throw new Error("Loopback's inbox needs its navigation.");
	return navigation;
};

/**
 * A link to an ask. A plain click opens it in place, through the host's navigation; a modified or
 * middle click is left to the browser, so the ask opens in a new tab at its own address.
 */
export function AskLink({
	askId,
	onClick,
	children,
	...props
}: ComponentProps<"a"> & { readonly askId: string }) {
	const { hrefFor, onSelect } = useNavigation();
	return (
		<a
			{...props}
			href={hrefFor(askId)}
			onClick={(event) => {
				onClick?.(event);
				const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
				if (event.defaultPrevented || event.button !== 0 || modified) return;
				event.preventDefault();
				onSelect(askId);
			}}
		>
			{children}
		</a>
	);
}

/** The element the inbox is drawn in, so its shortcuts leave the rest of the page alone. */
export const RootContext = createContext<RefObject<HTMLElement | null> | null>(null);

/**
 * Listens for keys anywhere on the page except the host's own controls: an ask that opens by itself
 * has nothing focused, so its shortcuts must work from the page itself, but keys typed into a search
 * box beside the inbox belong to that box.
 */
export const useInboxKeys = (onKey: (event: KeyboardEvent) => void) => {
	const root = use(RootContext);
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			const target = event.target;
			const onPage = target === document.body || target === document.documentElement;
			const outside =
				root?.current != null &&
				target instanceof Node &&
				!onPage &&
				!root.current.contains(target);
			if (!outside) onKey(event);
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	});
};
