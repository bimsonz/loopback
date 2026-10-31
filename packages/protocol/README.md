# @loopbackhq/protocol

The [Loopback](https://github.com/bimsonz/loopback) API contract. One TypeSpec definition
(`spec/main.tsp`) describes the REST operations an inbox uses, the frames the event socket sends,
and the inputs and results of the MCP tools. This package carries what is generated from it:

- `@loopbackhq/protocol`: framework-free TypeScript types for every shape, such as `Ask`, `Reply`
  and `ServerEvent`.
- `@loopbackhq/protocol/openapi.json`: the OpenAPI 3.1 document, for clients in any language.
- `@loopbackhq/protocol/document`: the same document as a module, which the server serves.

To build a frontend, use [`@loopbackhq/sdk`](https://www.npmjs.com/package/@loopbackhq/sdk), which
is typed with these.

MIT licensed.
