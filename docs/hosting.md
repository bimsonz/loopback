# Hosting Loopback for many people

Loopback is a single-tenant Worker. To serve many people, run one copy of the same build per tenant
on [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/):
each tenant gets a user Worker in a dispatch namespace, with its own Durable Objects, bucket and
secret, and a dispatch Worker in front decides who is calling and routes to the right copy. Nothing
in this repository changes for it.

## What a tenant's Worker is made of

Build from a clean checkout (`pnpm install && pnpm --filter loopback build`). The build writes
Cloudflare's Build Output to `apps/loopback/.cloudflare/output/v0/workers/default/`:

| Path                 | What it is                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `bundle/index.js`    | The Worker: one ES module, exporting the `fetch` handler and the `Space` class.                       |
| `worker.config.json` | The resolved configuration: compatibility date and flags, assets, bindings, `exports`, observability. |
| `assets/`            | The inbox's static files, `_headers` among them.                                                      |

Upload each copy with the [script upload API](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/),
taking the metadata from `worker.config.json`:

- `main_module`: `index.js`, with `compatibility_date` and `compatibility_flags` as built.
- `bindings`: `FILES` as an `r2_bucket` naming the tenant's own bucket, and `LOOPBACK_TOKEN` as
  `secret_text`, a random value of at least 32 characters that nobody needs to know, since the
  dispatcher vouches for every caller. There is no Durable Object binding: Loopback reaches its
  spaces through the runtime's own binding for the `Space` class the Worker exports, whatever the
  script is called.
- `exports`: `{ "Space": { "type": "durable-object", "storage": "sqlite" } }`, the same on every
  upload. The first upload creates the `Space` namespace, and there are no migration tags to track.
- `assets`: the inbox's files through an assets upload session, configured as `worker.config.json`
  says (single-page application, the Worker first for `/api/*`, `/mcp` and `/.well-known/*`).
- `observability`, as built, so each tenant's logs can be read by its script name.

## What the dispatcher does

- **Routes by hostname.** Each tenant has a hostname of its own, such as `<tenant>.example.com`, or
  a custom hostname through Cloudflare for SaaS. Forward the request with its URL unchanged: Loopback
  builds the inbox's address and upload URLs from it.
- **Signs people in, and vouches for them.** Authenticate however your service does (a session cookie
  for the inbox, OAuth or API keys for agents), then invoke the tenant's Worker with props:

  ```ts
  const worker = env.DISPATCHER.get(tenant.script, {
  	props: { loopback: { space: "default", actor: { id: user.id, name: user.name } } },
  });
  return worker.fetch(request);
  ```

  Only code deployed on the account can set props, so they need no secret. Loopback believes them
  before its own token gate, refuses malformed ones outright, and its inbox, finding itself signed
  in, never asks for a token. A request dispatched without props meets the token gate, which
  refuses it, so pass props on every request you have signed in.

- **Lets uploads through.** `PUT /api/v1/uploads/{space}/{token}` carries no credentials: the URL is
  the credential. Forward it without a session, with its `Content-Length`.
- **Answers OAuth discovery** for MCP clients that need it, at `/.well-known/oauth-protected-resource`,
  before dispatching.

## Upgrading

Upload the new build to every tenant's script, with `keep_assets` when the inbox's files have not
changed. User Workers have no gradual deployments, so upgrade a few tenants first. Confirm each one
from outside: `GET https://<tenant>/api/v1/openapi.json` names the release in `info.version`.

An upgrade resets the tenant's Durable Object. Agents following background tasks simply poll again;
a call waiting on a reply has its call into the space retried on a fresh stub, as Cloudflare marks a
reset as retryable. Schema migrations run in each object when it next starts, and only forward: a
release that adds one cannot be rolled back past it.
