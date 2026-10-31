# Versioned messages between Loopback's parts

**Status:** proposal, not built.

For a while after every deploy, the parts of a Loopback deployment run different versions of the
code. Anything a deploy changes can then reach a part that doesn't understand it. This note is how
every part says which version of a message it wrote, and what the reader does about it.

## Why

Briefings hit this in production on 2026-10-31:

- 01:25 UTC: briefings were deployed.
- 01:28 UTC: an agent called `send_briefing`. The new Worker accepted it and passed it to the space.
- The space was still running the code from before briefings. That code treated any kind that wasn't
  a question as a review, so it stored the briefing as a review with no `content`, and broadcast it
  to the open inbox.
- The call then failed for the agent (`SchemaError` decoding the space's reply).
- The inbox crashed drawing the review, and crashed again on every reload, because the URL pointed
  at that ask.
- `/snapshot`, `/asks/:id` and history returned 500, because the stored record failed the contract's
  response check.

`b103cdc` (a space refuses a kind it doesn't know, and each ask renders in an error boundary) and
`7034b14` (migration `0005` repairs the bad records) contained it. They don't fix the cause.

**The cause is ours.** No message says which version of the contract it was written for, and the
side receiving it doesn't check what it got:

- the space runs whatever arguments a call passes, unchecked (`space/object.ts`, `call`);
- the SDK casts responses to the contract's types (`json<Ask>(…)`), and checks socket frames only
  for their `type`;
- stored asks are read back with `JSON.parse` and a `switch` on their kind.

So old code met a new message and guessed.

## Where old and new code meet

| Crossing                                              | How old and new meet                                                                                                                                               | Today                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **1. Worker → space** (`call(method, args)`)          | A new Worker calls a space still on old code. Cloudflare defers an active Durable Object's code update for up to 5 minutes by default.                             | Arguments are not checked. The reply is decoded.                                      |
| **2. Space and server → inbox** (socket frames, REST) | A tab opened before a deploy keeps its old bundle. A hibernated inbox socket also survives the space moving to new code, so an old tab can be talking to new code. | Frames are checked for `type` only. Responses are cast.                               |
| **3. Inbox → server** (replies, uploads)              | An old tab sends what the old contract knew. After a rollback, a newer tab sends to older code.                                                                    | Strict validation refuses unknown fields: right for old to new, wrong for new to old. |
| **4. Stored asks**                                    | New code reads rows old code wrote, always. Old code reads rows new code wrote: after a rollback, and inside the window above (the incident).                      | Read without checking. Migrations only run forward.                                   |
| **5. Agents over MCP**                                | An agent holds the tool list it fetched when its session started.                                                                                                  | MCP versions its own protocol per request. Tool inputs are validated strictly.        |

Frontends built on the SDK, including a host's own, meet crossings 2 and 3 through the SDK.

## The rules

1. **One source.** The TypeSpec contract declares every message and every revision of it. It already
   declares every message: the HTTP API, the shapes MCP tools take and return, and the socket frames.
2. **Every crossing names the revision it was written at.**
3. **Newer code reads every older revision,** upgrading a message one revision at a time.
4. **Older code that meets a newer message never guesses.** A space refuses it, and the caller tries
   again on fresh code. An inbox shows it as "This ask can't be shown", and reloads.
5. **Everything read is decoded, never cast.** Fields the reader doesn't know are ignored. What we
   write is checked strictly, as now.
6. **Every revision's messages are kept as frozen examples,** and current code must read all of them.

## Two markers

- **Revision**: the shape of the contract. A whole number, declared in TypeSpec with
  `@typespec/versioning`, which the protocol package already depends on but doesn't use. It goes up
  whenever the emitted contract changes. A test fails if the contract changes without a new revision.
- **Build**: which deploy is running. Ordered: the version's creation time, from Cloudflare's
  version metadata binding. Every deploy changes it.

Both are needed. The revision says whether two parts can read each other's messages. The build says
whether they run the same code. A space must run the same code as the Worker calling it, because
logic changes as well as shapes. A tab only has to read the messages.

## How each crossing works

### 1. Worker → space

- Every call carries `{ revision, build }`.
- **A space whose build is older than its caller's restarts itself** (`ctx.abort()`), before it
  runs anything. Today the Worker retries only the operations that are safe to run twice, so a reply
  would not be retried. Because the space refused before running the operation, every operation is
  safe to try again in this one case, and the Worker retries it on a fresh instance running the new
  code.
- A space whose build is newer than its caller's carries on: a Worker isolate still finishing on the
  old code. It accepts every older revision and upgrades the arguments.
- **Each operation decodes its arguments** against an input schema before running. A call naming a
  revision newer than the space reads is refused with a retryable error, never run.

### 2. Space and server → inbox

- The first socket frame, the snapshot, carries the server's revision and build. Every REST response
  carries them as `Loopback-Revision` and `Loopback-Build` headers.
- **A tab on an older revision reloads.** Drafts are already in `localStorage`, so nothing is lost.
  A tab on the same revision but an older build may offer a reload, without forcing one.
- **The SDK decodes every frame and response** with schemas generated from the contract. Each union a
  release can grow (kinds of ask, reply outcomes, content blocks, event types) gets an `unknown`
  member. The SDK's types include it, so a frontend's exhaustive `switch` has to handle it, and the
  compiler says so. Until the tab reloads, an unknown kind is drawn as "can't be shown".

### 3. Inbox → server

- Requests carry `Loopback-Revision`. A server on a newer revision upgrades an older request body.
- A server on an older revision, which only happens after a rollback, answers `409` with the code
  `reload`, and the SDK reloads.
- Strict validation of the current revision stays.

### 4. Stored asks

- Asks and their entries gain a `revision` column. Existing rows are revision 1.
- Reading decodes a row at its revision and upgrades it.
- **A row newer than the code reading it** (after a rollback) is shown as "can't be shown" and left
  alone. Older code never rewrites it.
- Migrations stay forward-only and are applied when a space starts. A change to the tables adds
  columns and never drops or repurposes one in the same release, so older code still runs against a
  migrated table after a rollback.

### 5. Agents over MCP

- MCP already versions its own protocol on every request.
- Tool inputs only grow: new optional arguments, new tools. Renaming or removing an argument means a
  new tool.
- Strict validation stays. It is how an agent learns it sent something wrong.

## Where the schemas come from

TypeSpec stays the source:

1. The contract declares its revisions with `@typespec/versioning` (`@versioned`, `@added`,
   `@removed`, `@renamedFrom`, `@typeChangedFrom`). Today's contract becomes revision 1.
2. `@typespec/openapi3`, already in the build, emits one OpenAPI document per revision.
3. Effect's OpenAPI generator turns each into Effect schemas, generated into the protocol package.
4. The upgrade from one revision to the next is written by hand beside the spec, one function per
   message that changed, with `Schema.decodeTo`. Effect's `TaggedUnion` and `catchDecoding` give the
   unions and their `unknown` members.

The server's HTTP layer keeps the Zod validators `typespec-hono` generates.

Effect has no versioning model of its own: its RPC and event log modules have no notion of a
version. TypeSpec's versioning library is the model, and Effect supplies the schemas.

**Considered and rejected:**

- **Effect schemas as the source**, generating the OpenAPI document from `HttpApi`. It means
  rewriting the server's HTTP layer and the published contract to end up where this lands anyway.
- **Hand-written Effect schemas beside the TypeSpec.** Two sources drift, which is the kind of bug
  this note is meant to remove.

## Deploy settings

Keep Cloudflare's default deferred code updates, which keep hibernated sockets attached. The self-
restart moves a space onto new code as soon as a newer Worker calls it. `immediate` mode would
disconnect every active socket on every deploy, and would still leave a few seconds of mismatch.

## What changes where

Everything is in the open-source packages, and nothing in it is specific to any host:

- **protocol:** revisions in the contract, generated Effect schemas, the upgrades, the frozen
  examples, and the test that the contract can't change without a new revision;
- **sdk:** decoding, `unknown` members, revision headers, and the reload signal;
- **server:** the call envelope, the self-restart, decoding arguments, the row revision, and the
  headers;
- **inbox:** reloading, and drawing what it can't read as "can't be shown".

A host that builds on the packages updates them and binds version metadata. Its own pages
ship with its Worker, so the same reload signal covers them.

## To check first

- **Effect's OpenAPI generator:** its exact package, how mature it is, and whether it reads the
  OpenAPI 3.1 TypeSpec emits, discriminated unions included.
- **`typespec-hono` with `@versioned`:** whether it emits the latest revision cleanly.
- **Version metadata in a Durable Object:** whether a space sees the same binding and creation time
  as its Worker, and how both the `cf` config and Wrangler declare the binding.
- **A space restarting itself:** what the interrupted call sees, whether Cloudflare marks it
  retryable, and how it interacts with waiting laps and background tasks.
- **Timing:** the `unknown` members change the SDK's types. Shipping this in 0.4.0, the first npm
  release, means no SDK user ever meets that as a breaking change.

## Order of work

1. The checks above.
2. The contract: today's becomes revision 1, its messages are frozen as examples, and the test that
   it can't change without a new revision.
3. Generated Effect schemas, SDK decoding with `unknown` members, and the inbox drawing them.
4. Revision and build on every crossing, the self-restart, decoding arguments, and the row revision.
5. The reload signal, and the refusals after a rollback.
6. Release 0.4.0 to npm.

Each step is tested by making the failure happen first. One test replays the incident itself: a call
from a newer build reaches a space on an older one, which must restart rather than store anything.
