import { exports } from "cloudflare:workers";
import { Context, Effect, Layer, Option } from "effect";
import type { Space } from "../space/object.ts";
import { type SpaceClient, spaceClient } from "../space/rpc.ts";
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
