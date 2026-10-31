import { useAtomValue } from "@effect/atom-react";
import type { Actor } from "@loopbackhq/sdk";
import { AsyncResult } from "effect/reactivity";
import { useClient } from "./context.tsx";
import { meAtom } from "./state.ts";

/** Who the inbox is signed in as, once it knows. */
export const useMe = (): string | undefined =>
	AsyncResult.getOrElse(useAtomValue(meAtom(useClient())), () => undefined);

/**
 * Someone the deployment named, as the person reading sees them: "You" for themselves, and for anyone
 * the deployment could not name, as on a single-person inbox; otherwise their name.
 */
export const whoIs = (actor: Actor | undefined, me: string | undefined): string =>
	actor === undefined || actor.id === me || actor.name === undefined ? "You" : actor.name;
