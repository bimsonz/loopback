import { createLoopback, TokenGate } from "../src/index.ts";

export { Space } from "../src/index.ts";

export default createLoopback({ gate: TokenGate });
