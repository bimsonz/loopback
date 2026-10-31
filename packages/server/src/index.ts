export { createLoopback, type LoopbackOptions } from "./loopback.ts";
export { VERSION } from "./version.ts";
export { Space } from "./space/object.ts";
export { Declined, Unauthorized } from "./domain/errors.ts";
export type { Declinable, SpaceClient } from "./space/rpc.ts";
export { eraseSpace, Spaces } from "./worker/spaces.ts";
export type { LoopbackBindings, WorkerBindings } from "./worker/env.ts";
export { WorkerEnv } from "./worker/env.ts";
export {
	type Access,
	credentialOf,
	DEFAULT_SPACE,
	Gate,
	NotConfigured,
	TokenGate,
} from "./worker/gate.ts";
export { ConfiguredGate, jwtGate, type JwtGateOptions } from "./worker/jwt.ts";
export type { InboxLink } from "./worker/mcp.ts";
