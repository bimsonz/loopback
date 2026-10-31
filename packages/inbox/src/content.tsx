import { Loader, Text } from "@cloudflare/kumo";
import { CodeHighlighted } from "@cloudflare/kumo/code";
import { useAtomValue } from "@effect/atom-react";
import type { Block } from "@loopbackhq/sdk";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useClient } from "./context.tsx";
import { imageAtom } from "./state.ts";

/** The text inside a markdown node, which react-markdown hands over as children. */
const textOf = (node: ReactNode): string =>
	typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : "";

const markdownComponents: Components = {
	a: ({ href, children }) => (
		<a href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	),
	pre: ({ children }) => <>{children}</>,
	code: ({ className, children }) => {
		const language = /language-(\S+)/.exec(className ?? "")?.[1];
		const source = textOf(children).replace(/\n$/, "");
		if (language === undefined && !source.includes("\n")) return <code>{children}</code>;
		return <CodeHighlighted code={source} lang={language ?? "text"} showCopyButton />;
	},
};

/** Markdown an agent wrote. Links open in a new tab; fenced code is highlighted. */
export function Prose({ text }: { readonly text: string }) {
	return (
		<div className="loopback-markdown text-kumo-default">
			<Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
				{text}
			</Markdown>
		</div>
	);
}

function Caption({ children }: { readonly children: string }) {
	return (
		<Text variant="secondary" size="sm">
			{children}
		</Text>
	);
}

function Picture({ uploadId, caption }: { readonly uploadId: string; readonly caption?: string }) {
	const result = useAtomValue(imageAtom(useClient())(uploadId));
	if (AsyncResult.isFailure(result))
		return <Text variant="error">This image could not be loaded.</Text>;
	if (!AsyncResult.isSuccess(result)) {
		return (
			<div className="flex h-40 items-center justify-center rounded-lg bg-kumo-recessed">
				<Loader />
			</div>
		);
	}
	return (
		<a href={result.value} target="_blank" rel="noreferrer noopener">
			<img
				src={result.value}
				alt={caption ?? "An image the agent uploaded"}
				className="max-h-[70vh] max-w-full rounded-lg border border-kumo-line"
			/>
		</a>
	);
}

function Image({ uploadId, caption }: { readonly uploadId: string; readonly caption?: string }) {
	return (
		<figure className="flex flex-col gap-2">
			<Picture uploadId={uploadId} {...(caption === undefined ? {} : { caption })} />
			{caption === undefined ? null : <Caption>{caption}</Caption>}
		</figure>
	);
}

function BlockView({ block }: { readonly block: Block }) {
	switch (block.type) {
		case "markdown":
			return <Prose text={block.text} />;
		case "code":
			return (
				<div className="flex flex-col gap-1">
					{block.filename === undefined ? null : <Caption>{block.filename}</Caption>}
					<CodeHighlighted code={block.code} lang={block.language ?? "text"} showCopyButton />
				</div>
			);
		case "diff":
			return (
				<div className="flex flex-col gap-1">
					{block.filename === undefined ? null : <Caption>{block.filename}</Caption>}
					<CodeHighlighted code={block.diff} lang="diff" showCopyButton />
				</div>
			);
		case "image":
			return (
				<Image
					uploadId={block.uploadId}
					{...(block.caption === undefined ? {} : { caption: block.caption })}
				/>
			);
	}
}

/** What an agent put up for review, in order. */
export function Blocks({ blocks }: { readonly blocks: readonly Block[] }) {
	return (
		<div className="flex flex-col gap-4">
			{blocks.map((block, index) => (
				// Blocks are an ordered snapshot that never changes and has no ids: position is identity.
				// oxlint-disable-next-line react/no-array-index-key
				<BlockView key={index} block={block} />
			))}
		</div>
	);
}
