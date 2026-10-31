<p align="center">
  <img src="docs/assets/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">Loopback</h1>

<p align="center">A human-in-the-loop inbox for coding agents.</p>

<p align="center">
  <a href="https://github.com/bimsonz/loopback/actions/workflows/ci.yml"><img src="https://github.com/bimsonz/loopback/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue.svg" alt="Licence: MIT"></a>
</p>

When an agent needs a decision, a preference or your sign-off, it asks through Loopback instead of
guessing, or stopping in a terminal you are not watching. The ask appears in a live web inbox. You
answer there, and your reply comes back to the agent as the result of its tool call, so it carries
straight on.

Loopback is an MCP server on Cloudflare Workers: one Worker, one Durable Object per inbox, and the
inbox itself served from the same deployment. You run it on your own Cloudflare account.

## Features

- **Questions and reviews.** Agents ask questions, with or without choices, and show you work for a
  verdict: copy, a plan, code, a diff, a screenshot.
- **Briefings, point by point.** When an agent explains something that breaks into several points,
  you reply on each point on its own, drill into it through sub-points the agent adds, and resolve
  it. Each point is one line until opened, so what still needs you is plain to see.
- **Ways to reply that fit the ask.** Answer (pick choices, write your own words, or both), approve
  with an optional note, request changes, ask a question back, reply on a briefing's points, or
  dismiss.
- **Agents don't stop for you.** On clients that support MCP background tasks, an ask returns at
  once and the reply arrives when you give it. Other clients wait, kept alive by progress updates.
- **One inbox for every project.** Each ask names the project it comes from, so agents in many
  repositories share one inbox.
- **Nothing lost.** Asks and replies live in SQLite. A call retried after a dropped connection
  rejoins the ask it opened, and a reply waits for the agent that asked.
- **A live inbox.** Grouped by whose turn it is, updated as agents ask, with keyboard shortcuts and
  opt-in notifications.
- **Claude Code plugin.** Routes every question Claude Code has for you to Loopback, without your
  having to ask it to.
- **Spec-first API.** The REST API, event socket and MCP tools are defined once in TypeSpec, with a
  typed SDK for building your own inbox.

## Tools

| Tool                  | What it does                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| `ask_question`        | Asks you something, optionally with choices.                                            |
| `request_review`      | Shows you work for your verdict: approve, request changes, ask back or dismiss.         |
| `answer_follow_up`    | Answers a question you asked back, keeping the same ask open.                           |
| `send_briefing`       | Explains something as points you reply on one at a time, and resolve.                   |
| `answer_briefing`     | Answers your replies on a briefing, point by point, breaking points into sub-points.    |
| `create_image_upload` | Hands out a one-time URL for an image to show in a review.                              |
| `open_inbox`          | Gives the address of your inbox, or of one ask in it, so the agent can open it for you. |

The server tells agents when to use each tool, so asking an agent to "show me the copy" or "check
with me before you pick" is enough.

## Quick start

You need a Cloudflare account with R2 enabled, Node 24.22 or later (or 22.23 or later), and pnpm 11.
Loopback deploys with [`cf`](https://developers.cloudflare.com/cf/), Cloudflare's CLI, which is in
beta; `pnpm install` installs it for you.

```sh
git clone https://github.com/bimsonz/loopback.git
cd loopback
pnpm install
pnpm --filter loopback exec cf auth login
printf 'LOOPBACK_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/loopback.secrets
pnpm run deploy --secrets-file ~/loopback.secrets
```

The deploy builds the inbox, creates the Worker with your token as its secret, and provisions its R2
bucket.

Open the `workers.dev` URL the deploy printed, and sign in with the token from `~/loopback.secrets`.
Keep the token somewhere safe, such as a password manager, then delete the file. It must be at least
32 characters, and it only ever travels in the `Authorization` header, which Cloudflare keeps out of
its logs.

Later deploys keep the token, so `pnpm run deploy` is enough. To change it, put a new one in a
secrets file and deploy with `--secrets-file` again.

## Connect an agent

### Claude Code

Install the plugin from this repository, then give it your deployment's URL and token:

```sh
claude plugin install loopback --marketplace bimsonz/loopback
printf '{"url":"https://<your-worker>","token":"<your-token>"}' \
  | claude plugin configure loopback@loopback --values-stdin
```

The plugin connects Claude Code to Loopback and routes every question the agent has for you there.
[`integrations/claude-code`](integrations/claude-code/README.md) explains what it does.

### Any MCP client

Loopback serves MCP over Streamable HTTP at `/mcp`, authenticated with your token as a bearer
header. Most clients take a configuration like this:

```json
{
	"mcpServers": {
		"loopback": {
			"type": "http",
			"url": "https://<your-worker>/mcp",
			"headers": { "Authorization": "Bearer <your-token>" }
		}
	}
}
```

Behind a login, through the JWT gate, agents sign in with OAuth instead and need no token in their
configuration: [`docs/hosting.md`](docs/hosting.md) explains it.

A client that supports MCP background tasks (`io.modelcontextprotocol/tasks`), such as Claude Code
2.1.304 and later, gets each ask back at once and carries on. A client without them waits for your
reply, which can take minutes. Loopback sends progress updates to keep the call alive, but a client
that caps tool calls at a fixed timeout needs that limit raised.

## How it works

The Worker authenticates each request and hands it to a `Space` Durable Object, which holds the
asks, their threads and the connected inboxes in SQLite. Agents reach it through MCP; the inbox
through a REST API and an event socket. Images go to R2.
[`docs/architecture.md`](docs/architecture.md) explains how it fits together.

## Build your own inbox

The web inbox in `apps/loopback` is built only on `@loopbackhq/sdk`, a client for the REST calls,
the live event socket and the inbox state, with a promise API for any framework and an Effect
service. [`packages/sdk`](packages/sdk/README.md) explains how to use it. The API is also described
by an OpenAPI document, served at `/api/v1/openapi.json`, for clients in any language.

## Hosting for many people

One deployment can serve many tenants. Point its JWT gate at any login that issues JWTs, and each
token's claims name the space it opens and the person; every space is its own Durable Object, and
agents sign in with OAuth. [`docs/hosting.md`](docs/hosting.md) explains how.

## Development

```sh
cp apps/loopback/.dev.vars.example apps/loopback/.dev.vars
pnpm dev              # the Worker and the inbox, with hot reload
pnpm test             # every package's tests
pnpm lint             # oxlint
pnpm typecheck
pnpm format           # oxfmt
pnpm generate         # regenerate the API from its TypeSpec definition
```

| Path                       | What it is                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/protocol`        | The API contract, in TypeSpec, and what is generated from it: types and the OpenAPI document. |
| `packages/server`          | The server: Durable Object, HTTP API, event socket and MCP tools, written in Effect.          |
| `packages/sdk`             | A client for building your own inbox, in any framework.                                       |
| `apps/loopback`            | The deployable Worker and the web inbox.                                                      |
| `integrations/claude-code` | The Claude Code plugin.                                                                       |

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setting up, the
checks a change has to pass, and changing the API.

## Security

Please report vulnerabilities privately, as [`SECURITY.md`](SECURITY.md) describes, not in a public
issue.

## Licence

[MIT](LICENSE)
