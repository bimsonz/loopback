# Code versions drift apart after every deploy

For a while after every deploy, the parts of a Loopback deployment can run different versions of
the code. Anything a deploy adds can then reach a part that doesn't understand it. Briefings hit
this in production on 2026-10-31. This note is to pick up alongside the hosted product.

## The three places versions drift apart

1. **The Worker and each space.** By default, Cloudflare lets an _active_ Durable Object keep
   running its old code for up to 5 minutes after a deploy
   ([code update strategy](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)).
   An open inbox or a waiting agent keeps a space active. A new Worker can therefore call a space
   that is still on old code.
2. **Inbox tabs opened before a deploy.** They keep running the old bundle. An old tab that receives
   a kind of ask it doesn't know crashes when it tries to draw it.
3. **Frontends built on the SDK**, including the hosted product. Their exhaustive switches are
   checked at compile time, but at runtime they meet kinds of ask and outcomes released after they
   were built.

## What happened

- 01:25 UTC: briefings were deployed.
- 01:28 UTC: an agent called `send_briefing`. The new Worker accepted it and passed it to the space.
- The space was still on the pre-briefings code. That code treated any kind that wasn't a question
  as a review, so it stored the briefing as a review with no `content`, and broadcast it to the open
  inbox.
- The call then failed for the agent (`SchemaError` decoding the space's reply).
- The inbox crashed while drawing the review (`Blocks` mapped over `undefined`). Because the URL hash
  pointed at that ask, every reload crashed again.
- The broken record also made `/snapshot`, `/asks/:id` and history return 500, because the review
  fails the contract's response check.

## Already in `main`

- `b103cdc`: a space refuses a kind of ask it doesn't know, with `ContentInvalid` and a "try again
  in a few minutes" message, rather than storing it as another kind. Each ask in the inbox renders
  inside an error boundary, so one that can't be drawn shows "This ask can't be shown" and can still
  be dismissed.
- `7034b14`: migration `0005` repairs reviews that were stored without content.

These stop bad data and crashes, but not the mismatch. During the window, an agent's call can still
fail, and an old inbox tab can still crash on a new kind.

## Proposal (not built)

- **Spaces check their own version.** The Worker sends its build with each call to a space. A space
  older than its caller resets itself (`ctx.abort()`), and the Worker's existing retry reaches a
  fresh instance running the new code. A space newer than its caller carries on: newer code must
  accept older requests. Needs an _ordered_ build marker, such as the version's upload time, since
  version ids aren't ordered.
- **The inbox reloads when the deployment changes.** The event socket's snapshot carries the
  server's build. On a mismatch, the inbox reloads, or offers to. Drafts are already in
  `localStorage`, so a reload loses nothing.
- **A written forward-compatibility rule** for frontends: unknown ask kinds and reply outcomes are
  shown as "can't be shown", never crash. The SDK could help with a guard.
- **Optionally:** deploy with `code_update_strategy: immediate`. `cf` (1.0.0-beta.24 to beta.26)
  can't set it, so it would need wrangler or a REST deployment call after `cf deploy`. Even then, a
  few seconds of mismatch remain, so it doesn't replace the version check.

## To check first

- Whether `cf` config can bind version metadata (`CF_VERSION_METADATA`), and whether a Durable
  Object sees its own running version through it.
- How a self-reset interacts with laps that are waiting, and with background tasks.
- How the hosted product deploys its Worker and spaces, and whether it has its own frontend that
  needs the forward-compatibility rule.
