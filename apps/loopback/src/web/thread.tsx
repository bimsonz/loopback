import { Text } from "@cloudflare/kumo";
import type { Block } from "@loopbackhq/sdk";
import { Blocks, Prose } from "./content.tsx";
import { age } from "./hooks.ts";

/** A turn the agent took in a thread: its answer, and anything it showed with it. */
export function AgentSaid({
	answer,
	content,
	at,
	now,
}: {
	readonly answer: string;
	readonly content?: readonly Block[] | undefined;
	readonly at: string;
	readonly now: number;
}) {
	return (
		<div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-base p-4">
			<Text variant="secondary" size="sm">
				The agent answered · {age(at, now)}
			</Text>
			<Prose text={answer} />
			{content === undefined ? null : <Blocks blocks={content} />}
		</div>
	);
}

/** A turn the person took in a thread: what they did, and their words when they gave any. */
export function PersonSaid({
	title,
	body,
	at,
	now,
}: {
	readonly title: string;
	readonly body?: string | undefined;
	readonly at: string;
	readonly now: number;
}) {
	return (
		<div className="ml-auto flex max-w-[85%] flex-col gap-1 rounded-lg bg-kumo-tint p-4">
			<Text size="sm" bold>
				{title} · <span className="font-normal text-kumo-subtle">{age(at, now)}</span>
			</Text>
			{body === undefined ? null : <Prose text={body} />}
		</div>
	);
}
