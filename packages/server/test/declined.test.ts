import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "@effect/vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { ConfiguredGate, createLoopback, Declined, Spaces } from "../src/index.ts";

const ORIGIN = "https://loopback.test";
const LIMIT =
	"The free plan's 100 asks this month are used. Upgrade at https://example.test/billing.";

/** A host's wrapping of the spaces: every ask and upload past the limit is declined. */
const limited = Layer.effect(
	Spaces,
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		return Spaces.of({
			...spaces,
			of: (access) => {
				const space = spaces.of(access);
				return {
					...space,
					open: () => Effect.fail(new Declined({ reason: LIMIT })),
					createUpload: () => Effect.fail(new Declined({ reason: LIMIT })),
				};
			},
		});
	}),
).pipe(Layer.provide(Spaces.layer));

const connect = async (app: ReturnType<typeof createLoopback>) => {
	const settings = { ...env };
	const client = new Client({ name: "declined-test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			fetch: async (url, init) =>
				app.fetch(new Request(url, init), settings, createExecutionContext()),
			requestInit: { headers: { Authorization: `Bearer ${env.LOOPBACK_TOKEN}` } },
		}),
	);
	return client;
};

const textOf = (result: { content?: unknown }) =>
	Array.isArray(result.content)
		? result.content.map((part: { text?: string }) => part.text ?? "").join("\n")
		: "";

describe("a deployment that wraps its spaces", () => {
	const app = createLoopback({ gate: ConfiguredGate, spaces: limited });

	it("tells the agent why an ask was declined, as the tool's error", async () => {
		const client = await connect(app);
		for (const [name, args] of [
			[
				"ask_question",
				{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], project: "declined" },
			],
			[
				"request_review",
				{ title: "Copy", content: [{ type: "markdown", text: "Hello" }], project: "declined" },
			],
			["create_image_upload", { contentType: "image/png" }],
		] as const) {
			const result = await client.callTool({ name, arguments: args });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe(LIMIT);
		}
		await client.close();
	});

	it("leaves everything it does not wrap to the space", async () => {
		const response = await app.fetch(
			new Request(`${ORIGIN}/api/v1/snapshot`, {
				headers: { Authorization: `Bearer ${env.LOOPBACK_TOKEN}` },
			}),
			{ ...env },
			createExecutionContext(),
		);
		expect(response.status).toBe(200);
	});
});
