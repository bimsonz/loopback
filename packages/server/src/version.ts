import packageJson from "../package.json" with { type: "json" };

/** This release of Loopback: what the MCP server and the OpenAPI document report. */
export const VERSION: string = packageJson.version;
