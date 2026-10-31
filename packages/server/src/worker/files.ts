import { Context, Effect, Layer, Option } from "effect";
import { UploadIncomplete } from "../domain/errors.ts";
import { WorkerEnv } from "./env.ts";

/** Uploaded images, kept in R2 under the space that holds them. */
export class Files extends Context.Service<
	Files,
	{
		/**
		 * Stores exactly `length` bytes from `body`. A body that turns out longer or shorter than it
		 * declared is refused by the stream itself, so the size limit holds whatever the client claims.
		 * R2 failing is a defect: nothing the client sent caused it.
		 */
		readonly put: (
			key: string,
			body: ReadableStream<Uint8Array>,
			length: number,
			contentType: string,
		) => Effect.Effect<void, UploadIncomplete>;
		readonly get: (key: string) => Effect.Effect<Option.Option<ReadableStream<Uint8Array>>>;
	}
>()("loopback/Files") {
	static readonly layer = Layer.effect(
		Files,
		Effect.gen(function* () {
			const env = yield* WorkerEnv;
			return Files.of({
				put: (key, body, length, contentType) =>
					Effect.gen(function* () {
						const sized = new FixedLengthStream(length);
						// A wrong length fails both the pipe and R2's put, as R2 failing does, so what the
						// body itself did decides whose fault it was.
						let seen = 0;
						let ended = false;
						const counted = body.pipeThrough(
							new TransformStream<Uint8Array, Uint8Array>({
								transform: (chunk, controller) => {
									seen += chunk.byteLength;
									controller.enqueue(chunk);
								},
								flush: () => {
									ended = true;
								},
							}),
						);
						const [stored, piped] = yield* Effect.promise(() =>
							Promise.allSettled([
								env.FILES.put(key, sized.readable, { httpMetadata: { contentType } }),
								counted.pipeTo(sized.writable),
							]),
						);
						if (seen > length || (ended && seen !== length)) return yield* new UploadIncomplete();
						if (stored.status === "rejected") return yield* Effect.die(stored.reason);
						if (piped.status === "rejected") return yield* Effect.die(piped.reason);
					}),
				get: (key) =>
					Effect.promise(() => env.FILES.get(key)).pipe(
						Effect.map((object) => Option.map(Option.fromNullishOr(object), (found) => found.body)),
					),
			});
		}),
	);
}

/** Where every file a space holds lives, under one prefix. */
export const filesOf = (spaceId: string) => `spaces/${spaceId}/`;

/** Where an upload's bytes live. */
export const fileKey = (spaceId: string, uploadId: string) =>
	`${filesOf(spaceId)}uploads/${uploadId}`;
