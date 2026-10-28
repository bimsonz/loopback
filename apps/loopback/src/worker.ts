import { createLoopback, TokenGate } from "@loopbackhq/server";

export { Space } from "@loopbackhq/server";

export default createLoopback({ gate: TokenGate });
