import { Button, Empty, Input, Loader, Text } from "@cloudflare/kumo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { awaitingHuman, initialInbox, type InboxState } from "@loopbackhq/sdk";
import { Bell, BellSlash, CheckCircle, Tray } from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
	type CSSProperties,
	type FormEvent,
	type KeyboardEvent,
	type PointerEvent,
	useRef,
	useState,
} from "react";
import { AskDetail } from "./detail.tsx";
import {
	focusOf,
	nextAfter,
	select,
	SIDEBAR,
	useAttention,
	useNotifications,
	useSelectedAsk,
	useSidebarWidth,
} from "./hooks.ts";
import { AskList } from "./list.tsx";
import { hostedAtom, inboxAtom, signInAtom, tokenAtom } from "./state.ts";

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
	inbox,
	onSignOut,
}: {
	readonly inbox: InboxState;
	/** Absent when the page's host owns the session: there is nothing here to sign out of. */
	readonly onSignOut: (() => void) | undefined;
}) {
	const notifications = useNotifications();
	useAttention(inbox, notifications.enabled);
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

/** The edge between the list and the ask: drag it, or focus it and use the arrow keys. */
function ResizeHandle({
	width,
	onResize,
}: {
	readonly width: number;
	readonly onResize: (width: number) => void;
}) {
	const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		drag.current = { x: event.clientX, width };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (drag.current !== null) onResize(drag.current.width + event.clientX - drag.current.x);
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		drag.current = null;
		event.currentTarget.releasePointerCapture(event.pointerId);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") onResize(width - 16);
		else if (event.key === "ArrowRight") onResize(width + 16);
		else return;
		event.preventDefault();
	};
	return (
		// An <hr> is a static separator; a splitter that resizes is the focusable kind, which only
		// role="separator" can express.
		<div
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize the inbox list"
			aria-valuenow={width}
			aria-valuemin={SIDEBAR.min}
			aria-valuemax={SIDEBAR.max}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onKeyDown={onKeyDown}
			className="relative z-10 -ml-1 hidden w-2 shrink-0 cursor-col-resize touch-none outline-none transition-colors hover:bg-kumo-line focus-visible:bg-kumo-brand md:block"
		/>
	);
}

function Inbox({ withToken }: { readonly withToken: boolean }) {
	const setToken = useAtomSet(tokenAtom);
	const result = useAtomValue(inboxAtom);
	const inbox = AsyncResult.getOrElse(result, () => initialInbox);
	const selectedId = useSelectedAsk();
	// On a wide screen the top waiting ask opens by itself; on a phone the list comes first.
	const focusId = focusOf(inbox, selectedId);
	const selected =
		focusId === null
			? undefined
			: [...inbox.open, ...inbox.recent].find((ask) => ask.id === focusId);
	const [width, resize] = useSidebarWidth();
	const signOut = () => {
		setToken(null);
	};
	// Once an ask is answered, open whatever else awaits the person; with nothing left, clear the
	// view so it shows that everything is done rather than the ask just answered.
	const advance = (answered: string) => select(nextAfter(awaitingHuman(inbox), answered));
	const allDone = inbox.status === "live" && awaitingHuman(inbox).length === 0;

	return (
		<div className="flex h-full flex-col">
			<Header inbox={inbox} onSignOut={withToken ? signOut : undefined} />
			<div className="flex min-h-0 flex-1">
				<aside
					style={{ "--sidebar": `${width}px` } as CSSProperties}
					className={`w-full overflow-y-auto border-r border-kumo-line bg-kumo-base md:block md:w-(--sidebar) md:shrink-0 ${
						selectedId === null ? "" : "hidden"
					}`}
				>
					{inbox.status === "connecting" ? (
						<div className="flex justify-center p-8">
							<Loader />
						</div>
					) : inbox.open.length === 0 && inbox.recent.length === 0 ? (
						<Empty
							icon={<Tray size={32} />}
							title="Nothing yet"
							description="When an agent asks you something, it appears here."
						/>
					) : (
						<AskList inbox={inbox} selected={focusId} />
					)}
				</aside>
				<ResizeHandle width={width} onResize={resize} />
				<main
					className={`min-w-0 flex-1 overflow-y-auto md:block ${selectedId === null ? "hidden" : ""}`}
				>
					{selected !== undefined ? (
						<AskDetail ask={selected} onReplied={() => advance(selected.id)} />
					) : selectedId !== null && inbox.status === "live" ? (
						<Empty title="Not in the inbox" description="This ask is older than the inbox keeps." />
					) : (
						<div className="hidden h-full items-center justify-center md:flex">
							{allDone ? (
								<div className="w-full max-w-sm">
									<Empty
										icon={<CheckCircle size={32} weight="duotone" />}
										title="All done"
										description="Nothing needs you right now."
									/>
								</div>
							) : null}
						</div>
					)}
				</main>
			</div>
		</div>
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
	return hosted.value ? <Inbox withToken={false} /> : <SignIn />;
}

export function App() {
	const token = useAtomValue(tokenAtom);
	return token === null ? <Unsigned /> : <Inbox withToken />;
}
