import { RegistryProvider } from "@effect/atom-react";
import { make } from "@loopbackhq/sdk";
import { type ReactNode, useState } from "react";
import { type InboxNavigation, InboxProvider, NavigationContext } from "../src/context.tsx";

/** Where a component drawn on its own is told to go; nowhere, unless a test says. */
export const stayPut: InboxNavigation = {
	selectedId: null,
	onSelect: () => {},
	hrefFor: (askId) => `/asks/${askId}`,
};

/**
 * What a host gives the inbox: a registry, a client signed in with a token, and navigation. The
 * client is made on first render, so it sends through whatever `fetch` the test has stubbed.
 */
export function Host({
	children,
	navigation = stayPut,
}: {
	readonly children: ReactNode;
	readonly navigation?: InboxNavigation;
}) {
	const [client] = useState(() => make({ baseUrl: "http://loopback.test", token: "token" }));
	return (
		<RegistryProvider>
			<InboxProvider client={client}>
				<NavigationContext value={navigation}>{children}</NavigationContext>
			</InboxProvider>
		</RegistryProvider>
	);
}
