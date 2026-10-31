import { Button, Input, Loader, Text } from "@cloudflare/kumo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Inbox, InboxProvider, useAttention, useInbox, useNotifications } from "@loopbackhq/inbox";
import type { LoopbackApi } from "@loopbackhq/sdk";
import { Bell, BellSlash } from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useState } from "react";
import { hrefFor, select, useSelectedAsk } from "./hash.ts";
import { clientAtom, hostedAtom, signInAtom, tokenAtom } from "./session.ts";

function SignIn() {
	const setToken = useAtomSet(tokenAtom);
	const signIn = useAtomSet(signInAtom, { mode: "promiseExit" });
	const [token, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const exit = await signIn(token.trim());
		setBusy(false);
		if (Exit.isSuccess(exit)) {
			setToken(exit.value.token);
			return;
		}
		const failure = Cause.squash(exit.cause);
		setError(failure instanceof Error ? failure.message : "That token was not accepted.");
	};

	return (
		<main className="flex h-full items-center justify-center p-4">
			<form
				onSubmit={(event) => void submit(event)}
				className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-elevated p-6"
			>
				<div className="flex flex-col gap-1">
					<Text variant="heading" as="h1">
						Loopback
					</Text>
					<Text variant="secondary">Paste the token this deployment was set up with.</Text>
				</div>
				<Input
					label="Token"
					type="password"
					autoComplete="current-password"
					value={token}
					onChange={(event) => setDraft(event.target.value)}
					{...(error === null ? {} : { error })}
				/>
				<Button type="submit" variant="primary" loading={busy} disabled={token.trim() === ""}>
					Open the inbox
				</Button>
			</form>
		</main>
	);
}

const CONNECTION = {
	connecting: { label: "Connecting", tone: "bg-kumo-line" },
	live: { label: "Live", tone: "bg-kumo-success" },
	reconnecting: { label: "Reconnecting", tone: "bg-kumo-warning" },
} as const;

function Header({
	onSignOut,
}: {
	/** Absent when the page's host owns the session: there is nothing here to sign out of. */
	readonly onSignOut: (() => void) | undefined;
}) {
	const inbox = useInbox();
	const notifications = useNotifications();
	useAttention(inbox, notifications.enabled, select);
	const connection = CONNECTION[inbox.status];
	return (
		<header className="flex items-center gap-3 border-b border-kumo-line bg-kumo-base px-4 py-2.5">
			<img src="/favicon.svg" alt="" className="size-6" />
			<Text bold>Loopback</Text>
			<span className="inline-flex items-center gap-1.5 text-xs text-kumo-subtle">
				<span className={`size-2 rounded-full ${connection.tone}`} />
				{connection.label}
			</span>
			<span className="ml-auto flex items-center gap-1">
				{notifications.supported ? (
					<Button
						variant="ghost"
						size="sm"
						shape="square"
						aria-label={
							notifications.enabled ? "Turn notifications off" : "Notify me when an agent asks"
						}
						icon={notifications.enabled ? <Bell /> : <BellSlash />}
						onClick={() => void notifications.toggle()}
					/>
				) : null}
				{onSignOut === undefined ? null : (
					<Button variant="ghost" size="sm" onClick={onSignOut}>
						Sign out
					</Button>
				)}
			</span>
		</header>
	);
}

/** The inbox for one client: the header, and the inbox routed by the page's fragment. */
function Signed({
	client,
	onSignOut,
}: {
	readonly client: LoopbackApi;
	readonly onSignOut: (() => void) | undefined;
}) {
	const selectedId = useSelectedAsk();
	return (
		<InboxProvider client={client}>
			<div className="flex h-full flex-col">
				<Header onSignOut={onSignOut} />
				<Inbox selectedId={selectedId} onSelect={select} hrefFor={hrefFor} />
			</div>
		</InboxProvider>
	);
}

/** With no token held, the page's host may already have signed the person in. */
function Unsigned() {
	const hosted = useAtomValue(hostedAtom);
	if (!AsyncResult.isSuccess(hosted)) {
		return (
			<main className="flex h-full items-center justify-center">
				<Loader />
			</main>
		);
	}
	return hosted.value ? null : <SignIn />;
}

export function App() {
	const token = useAtomValue(tokenAtom);
	const client = useAtomValue(clientAtom);
	const setToken = useAtomSet(tokenAtom);
	if (client === null) return <Unsigned />;
	return <Signed client={client} onSignOut={token === null ? undefined : () => setToken(null)} />;
}
