import { describe, expect, it } from "@effect/vitest";
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { eraseSpace } from "../src/index.ts";
import { spaceClient } from "../src/space/rpc.ts";
import { fileKey } from "../src/worker/files.ts";

const OWNER = { id: "owner" };

const clientOf = (space: string) => spaceClient(() => exports.Space.getByName(space));

const ask = (space: string, question: string) =>
	Effect.runPromise(
		clientOf(space).open({
			actor: OWNER,
			kind: "question",
			input: { question, options: [{ label: "Yes" }, { label: "No" }], project: "erase-test" },
		}),
	);

/** Stores a file where an upload to `space` would have put it. */
const store = async (space: string, uploadId: string) => {
	const key = fileKey(exports.Space.idFromName(space).toString(), uploadId);
	await env.FILES.put(key, new Uint8Array([1, 2, 3]));
	return key;
};

describe("erasing a space", () => {
	it("deletes its asks and files, closes its inboxes, and leaves every other space alone", async () => {
		await ask("doomed", "Keep this?");
		await ask("kept", "Still here?");
		const doomedFiles = [await store("doomed", "one"), await store("doomed", "two")];
		const keptFile = await store("kept", "one");

		const upgrade = await exports.Space.getByName("doomed").fetch(
			new Request("https://loopback.test/", { headers: { Upgrade: "websocket" } }),
		);
		const socket = upgrade.webSocket!;
		const closed = new Promise<string>((resolve) => {
			socket.addEventListener("close", (event) => resolve(event.reason));
		});
		socket.accept();

		await eraseSpace(env, "doomed");

		expect(await closed).toBe("The space was erased.");
		const doomed = await Effect.runPromise(clientOf("doomed").snapshot());
		expect(doomed.open).toEqual([]);
		expect(doomed.recent).toEqual([]);
		for (const key of doomedFiles) expect(await env.FILES.head(key)).toBeNull();

		const kept = await Effect.runPromise(clientOf("kept").snapshot());
		expect(kept.open.map((item) => item.kind === "question" && item.prompt.question)).toEqual([
			"Still here?",
		]);
		expect(await env.FILES.head(keptFile)).not.toBeNull();
	});

	it("carries on as an empty space that takes new asks", async () => {
		await ask("reused", "Before?");
		await eraseSpace(env, "reused");
		await ask("reused", "After?");
		const reused = await Effect.runPromise(clientOf("reused").snapshot());
		expect(reused.open.map((item) => item.kind === "question" && item.prompt.question)).toEqual([
			"After?",
		]);
	});

	it("finishes on a second run what a first left, and erases a space that never held anything", async () => {
		await eraseSpace(env, "never-used");
		await store("half-done", "left-behind");
		await eraseSpace(env, "half-done");
		const listed = await env.FILES.list({
			prefix: `spaces/${exports.Space.idFromName("half-done").toString()}/`,
		});
		expect(listed.objects).toEqual([]);
	});
});
