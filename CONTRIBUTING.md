# Contributing to Loopback

Thanks for helping. Bug reports, fixes and improvements are all welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened instead. Include
  the client you connected with and its version when the bug involves an agent.
- **Changes:** for anything larger than a small fix, open an issue first, so we can agree on the
  approach before you spend time on it.
- **Security issues:** never in a public issue. See [`SECURITY.md`](SECURITY.md).

## Setting up

You need Node 24.22 or later (or 22.23 or later) and pnpm 11.

```sh
pnpm install
cp apps/loopback/.dev.vars.example apps/loopback/.dev.vars
pnpm dev
```

`pnpm dev` serves the Worker and the inbox together, with hot reload, at the address Vite prints.
Sign in with the token in `.dev.vars`. Connect an agent to the same address's `/mcp` to try asks end
to end.

## The checks

A pull request has to pass what CI runs:

```sh
pnpm generate:check   # the generated API matches its TypeSpec definition
pnpm typecheck
pnpm lint             # oxlint, warnings included
pnpm format:check     # oxfmt; run `pnpm format` to fix
pnpm test
pnpm build
```

The server's tests run inside the Workers runtime through `@cloudflare/vitest-plugin`, against a
local Durable Object and R2 bucket. The SDK's and the inbox's run in Node.

## Changing the API

Every shape Loopback speaks is defined once, in `packages/protocol/spec/main.tsp`. To change one,
edit the definition, run `pnpm generate`, and commit the generated files with your change. Never
edit a `*.gen.ts` file or `openapi.json` by hand: `pnpm generate:check` fails when they drift.

## Code

- TypeScript throughout. The server and the SDK are written in
  [Effect](https://effect.website): typed errors, services as layers, and no unhandled promises.
- Formatting is oxfmt's (tabs, 100 columns). Don't hand-format around it.
- Comments say why, not what. Name things by what they mean to someone using Loopback.
- A change in behaviour comes with a test that fails without it.

## Commits and pull requests

- Keep a pull request to one change, with its tests and any docs it affects.
- Write the commit summary as what the change does, in the imperative ("Refuse an empty project"),
  and say why in the body.

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
