# @loopbackhq/server

The Loopback server for Cloudflare Workers: the `Space` Durable Object that holds asks and their
threads, the REST API and event socket an inbox uses, the MCP tools agents call, and the gates that
decide who a request is from.

Most people deploy [Loopback](https://github.com/bimsonz/loopback) as it is. Use this package to
compose Loopback into a Worker of your own:

```ts
import { ConfiguredGate, createLoopback } from "@loopbackhq/server";

export { Space } from "@loopbackhq/server";

export default createLoopback({ gate: ConfiguredGate });
```

Declare the `Space` class as a Durable Object with SQLite storage, bind an R2 bucket as `FILES`, and
set either `LOOPBACK_TOKEN` (one space behind one secret) or the JWT settings (a space per tenant
behind your login). [`docs/hosting.md`](https://github.com/bimsonz/loopback/blob/main/docs/hosting.md)
explains the JWT gate, OAuth for MCP clients, and wrapping the spaces to meter or decline what
tenants open.

The package is written in [Effect](https://effect.website) and compiled against
`@cloudflare/workers-types`; its types refer to the Workers runtime's globals.

MIT licensed.
