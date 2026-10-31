import { exports } from "cloudflare:workers";
import { Context, Effect, Layer, Option } from "effect";
import type { Space } from "../space/object.ts";
import { type SpaceClient, spaceClient } from "../space/rpc.ts";
import type { WorkerBindings } from "./env.ts";
import { filesOf } from "./files.ts";
import type { Access } from "./gate.ts";

/**
 * The deployment's `Space` class, as the runtime binds every Durable Object class a Worker exports:
 * no binding in its configuration names the Worker, so a copy deployed under any name reaches its own.
 */
const namespace = (): DurableObjectNamespace<Space> =>
	(exports as unknown as { readonly Space: DurableObjectNamespace<Space> }).Space;

/** Reaches the space a caller's access opens. */
export class Spaces extends Context.Service<
	Spaces,
	{
		readonly of: (access: Access) => SpaceClient;
		/** The object id of the space an access opens: how uploads and files name it. */
		readonly idOf: (access: Access) => string;
		/** A space by its object id, as an upload URL names it. None when the id is not one. */
		readonly byId: (spaceId: string) => Option.Option<SpaceClient>;
		/** Hands an inbox's WebSocket upgrade to the space, named by an access or by its object id. */
		readonly connect: (space: Access | string, request: Request) => Effect.Effect<Response>;
	}
>()("loopback/Spaces") {
	static readonly layer = Layer.sync(Spaces, () => {
		const spaces = namespace();
		const stubOf = (access: Access) => spaces.getByName(access.space);
		return Spaces.of({
			of: (access) => spaceClient(() => stubOf(access)),
			idOf: (access) => spaces.idFromName(access.space).toString(),
			byId: (spaceId) => {
				if (!/^[0-9a-f]{64}$/.test(spaceId)) return Option.none();
				try {
					const id = spaces.idFromString(spaceId);
					return Option.some(spaceClient(() => spaces.get(id)));
				} catch {
					// A well-formed id this namespace did not mint.
					return Option.none();
				}
			},
			connect: (space, request) =>
				Effect.promise(() =>
					(typeof space === "string"
						? spaces.get(spaces.idFromString(space))
						: stubOf(space)
					).fetch(request),
				),
		});
	});
}

/**
 * Deletes everything a space holds: its asks and their threads, its tickets, and the files its
 * uploads stored. Inboxes watching it are closed, and it carries on as an empty space. For a host
 * removing a tenant; no request can reach it. Running it again finishes what a failed run left.
 */
export const eraseSpace = async (env: WorkerBindings, space: string): Promise<void> => {
	const spaces = namespace();
	await spaces.getByName(space).erase();
	await eraseFiles(env.FILES, filesOf(spaces.idFromName(space).toString()));
};

/** Deletes every file under a prefix, a page of listings at a time. */
const eraseFiles = async (files: R2Bucket, prefix: string): Promise<void> => {
	const listed = await files.list({ prefix, limit: 1000 });
	if (listed.objects.length > 0) await files.delete(listed.objects.map(({ key }) => key));
	if (listed.truncated) await eraseFiles(files, prefix);
};
