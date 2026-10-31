# @loopbackhq/sdk

Everything a frontend needs to read and answer what agents ask through Loopback: the REST calls,
the live event socket with reconnects, and the inbox state kept current from it.

It comes in two forms over one implementation: a promise client for any framework, and an Effect
service.

The SDK is part of this repository's workspace and isn't published to npm. Build your inbox here,
as an app under `apps/` that depends on `"@loopbackhq/sdk": "workspace:*"`, or in place of the one in
`apps/loopback`, which is built only on this SDK.

## Promise client

```ts
import { ApiError, createLoopbackClient } from "@loopbackhq/sdk";

const loopback = createLoopbackClient({
	baseUrl: "https://loopback.example.workers.dev",
	token: "…", // or a function returning a fresh one
});

const { open } = await loopback.snapshot();

try {
	await loopback.reply(open[0].id, { outcome: "approved", note: "Ship it" });
} catch (error) {
	if (error instanceof ApiError) console.log(error.status, error.code, error.message);
}
```

Replies are one of:

| `outcome`           | Fields                                  | For                           |
| ------------------- | --------------------------------------- | ----------------------------- |
| `answered`          | `selected: string[]`, `text?`           | questions                     |
| `approved`          | `note?`                                 | reviews                       |
| `changes_requested` | `feedback`                              | reviews                       |
| `follow_up`         | `question` — keeps the ask open         | questions, reviews            |
| `responded`         | `points: { point, text?, resolved? }[]` | briefings                     |
| `dismissed`         |                                         | questions, reviews, briefings |

A briefing's points, and where each stands, are folded from its prompt and thread by
`foldBriefing(ask.prompt, ask.thread)`: the tree an inbox renders, the points that need the person,
and those the agent owes an answer on. `respondedProblem` says why a `responded` reply would be
refused before it is sent.

`loopback.file(uploadId)` fetches an image a review shows, as a `Blob`.

### The live inbox

`loopback.inbox` is an external store. It connects when its first listener subscribes and
disconnects after its last one leaves.

```tsx
import { useSyncExternalStore } from "react";

function Inbox() {
	const inbox = useSyncExternalStore(loopback.inbox.subscribe, loopback.inbox.getSnapshot);
	return (
		<ul>
			{inbox.open.map((ask) => (
				<li key={ask.id}>{ask.kind === "question" ? ask.prompt.question : ask.prompt.title}</li>
			))}
		</ul>
	);
}
```

`InboxState` holds `status` (`connecting`, `live` or `reconnecting`), `open` (newest first) and
`recent` (most recently closed first). `awaitingHuman(state)` picks the asks waiting on the person.

## Effect

```ts
import { LoopbackClient } from "@loopbackhq/sdk";
import { Effect, Stream } from "effect";

const program = Effect.gen(function* () {
	const loopback = yield* LoopbackClient;
	yield* loopback.inbox.pipe(Stream.runForEach((state) => Effect.log(`${state.open.length} open`)));
});

program.pipe(
	Effect.provide(LoopbackClient.layer({ baseUrl: "https://…", token: "…" })),
	Effect.runFork,
);
```

`events` is the raw stream of socket frames, and `applyEvent` is the reducer `inbox` is built on,
for anyone keeping their own state.

## Types

Every type the API speaks (`Ask`, `Reply`, `Block`, `Snapshot`, …) is re-exported from
`@loopbackhq/protocol`, which is generated from the API's TypeSpec definition.
