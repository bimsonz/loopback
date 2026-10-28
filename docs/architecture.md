# Architecture

```
 agent (Claude Code, …)              browser, or any frontend on the SDK
      │  MCP over HTTP                      │  REST + WebSocket
      ▼                                     ▼
 ┌──────────────────────── Worker ─────────────────────────┐
 │ createLoopback({ gate })                                │
 │   Gate: request → Access { space, actor } | Unauthorized │
 │   /mcp · /api/v1/* · /api/v1/events · static inbox       │
 └──────────────┬──────────────────────────────┬───────────┘
                ▼ RPC                          ▼
        Space Durable Object (SQLite)       R2 (images)
        asks, threads, upload tickets,
        waiting agents, connected inboxes
```

## Asks

An **ask** is what an agent needs from a person: a question, or work to review. It is a short
thread. The agent's opening turn is the prompt; after that, entries alternate between the person's
replies and the agent's answers. An ask is `awaiting_human`, `awaiting_agent` (the person asked
something back) or `closed`. Every reply except a follow-up question closes it.

## Spaces and the gate

Everything lives in a **space**: one `Space` Durable Object, addressed by name. The only part of
Loopback that decides who a request is from, and which space it opens, is the `Gate` service:

```ts
class Gate extends Context.Service<
	Gate,
	{ readonly authenticate: (request: Request) => Effect.Effect<Access, Unauthorized> }
>()("loopback/Gate") {}
```

This repository's deployment provides `TokenGate`: one secret, one space. A deployment that serves
many people provides a different gate layer (one that verifies its own sessions and maps each tenant
to a space) and composes `@loopbackhq/server` with it, unchanged.

Before the gate, the Worker believes its **invoker**. Whatever invokes it with props, as a Workers
for Platforms dispatcher invokes a tenant's Worker or another Worker does through a service binding,
may vouch for the caller by passing `props.loopback`, `{ space, actor: { id, name? } }`. Only code
deployed on the account can set props, so nothing on the network can forge them and no secret is
shared. Props that say anything else are a misconfigured invoker, refused with a 500: never a reason
to fall back to the gate. A self-hosted Worker is invoked by no one, so its gate decides everything.

That is how one build runs **one copy per tenant** behind a dispatcher: the dispatcher signs people
in however it likes, routes each tenant's hostname to that tenant's Worker, and passes who is calling
in props. The inbox asks its host first and, finding itself signed in, never asks for a token. Nothing
in the server knows which model it is running under.

## The contract

`packages/protocol/spec/main.tsp` is the single definition of every shape Loopback speaks: the REST
operations a frontend uses, the frames the event socket sends, and the inputs and results of the
MCP tools. One `pnpm generate` produces, from it:

- the Hono routes and zod validators the server mounts (`packages/server/src/generated`);
- framework-free types for clients (`packages/protocol/src/generated`);
- the OpenAPI document, served at `/api/v1/openapi.json`.

Generated files are committed, and CI fails if they drift from the definition. The MCP tools are
registered by hand, because three of them block, but take their schemas from the same compile.

## The server

The server is written in Effect. Durable Object storage, R2, the gate and the route to a space are
services provided as layers. The Worker builds one runtime per environment; the Durable Object
builds its own. Each REST handler is an Effect program whose declared errors become the responses
the contract declares; anything else is a defect, logged and answered with a 500.

A space's operations run inside its Durable Object and cross RPC as their `Exit`, encoded as JSON,
so a typed error raised in the object arrives intact in the Worker.

## Getting a reply to the agent

People take minutes to reply, and an agent should not stop for them. Loopback hands replies back in
one of two ways, chosen per request by what the client says it supports.

**Background tasks.** A client that declares the MCP Tasks extension
(`io.modelcontextprotocol/tasks`) gets a task back from `ask_question`, `request_review` and
`answer_follow_up` at once, and carries on. A task follows one of the agent's turns on an ask: its
id is `<ask id>:<turn>`, where the turn is the thread entry the agent's move ended with (0 for
opening the ask). The client polls `tasks/get`, every two seconds at first and less often as the
wait grows, since each poll is a request to the space; the task completes with the first reply the
person gives after that turn, carrying the same result a waiting call would return. An
agent can have any number of tasks open. `tasks/cancel` stops a task: the ask stays open, and the
person can still answer it.

**Waiting.** A client without background tasks cannot be handed one, so its call holds its HTTP
request open and waits in **laps**. Each lap is a short RPC to the space, held for at most 25
seconds, ending early when a reply lands. Between laps the tool sends an MCP progress notification,
which keeps clients' idle timers from giving up.

A lap shows the agent the reply without handing it over: the Worker marks it delivered only once
its own call has it, so a lap whose caller has gone leaves the reply for the caller's retry.

Either way, everything is stored in SQLite. The Worker's calls into a space are retried on a fresh
stub when Cloudflare marks a failure retryable, as a reset by a deploy is, and the operation is safe
to run twice; a reply is not, so a refused one is the inbox's to send again. While polls or laps
arrive, the ask shows **agent waiting** in the inbox. Ten seconds after they stop, or at once when a
task is cancelled, it shows that the agent has gone. Replying is still possible, and the reply is
kept.

A retried call (the same question or review, from the same client and project) **rejoins** the ask
it opened, as long as an agent followed it within the last hour and it is still open or holds a
reply that never reached the agent. A dropped connection therefore never duplicates an ask or loses
a reply, while the same question asked again days later opens a fresh one.

## The inbox

The event socket (`/api/v1/events`) sends a snapshot of the space when it connects, then every
change. Browsers cannot set headers on a WebSocket, so an inbox first asks for a one-time ticket
(`POST /api/v1/events/tickets`, with its token in `Authorization`) and offers that as a subprotocol.
A ticket is spent on use and lapses within a minute, so the copy Cloudflare logs with the upgrade is
of no use; the token itself never leaves the header, which Cloudflare redacts. A client that can set
headers may instead send `Authorization` with the upgrade.
`@loopbackhq/sdk` wraps the REST calls and the socket, reconnects with backoff, and folds events
into an inbox state with a pure reducer. The web inbox in `apps/loopback` is built only on it.

## Images

`create_image_upload` mints a single-use ticket, valid for fifteen minutes, for one image type. The agent
uploads with `PUT` to the ticket's URL, which needs no credentials. The bytes stream into R2 at
exactly their declared length, so the size limit holds whatever the client claims. A review can show
only images its space holds.
