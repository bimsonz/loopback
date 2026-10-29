import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { projectFiles } from "archunit";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";

/**
 * The server's layers, and which way their imports may point: the domain knows nothing else here, the
 * space (the core: its Durable Object and operations) knows only the domain, and the worker (the edge:
 * HTTP, MCP, gates) may use both. A host composes the edge with its own adapters; nothing inside the
 * core may assume which ones.
 */
const LAYERS = ["src/domain", "src/space", "src/worker", "src/generated"] as const;

/** Every TypeScript file under a folder, as a path relative to the package. */
const filesIn = async (folder: string): Promise<string[]> =>
	(await readdir(folder, { recursive: true }))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(folder, name));

/** The modules a file imports, read from its import and export statements rather than its text. */
const importsOf = async (file: string): Promise<string[]> => {
	await init();
	const [imports] = parse(await readFile(file, "utf8"));
	return imports.flatMap((entry) => (typeof entry.specifier === "string" ? [entry.specifier] : []));
};

/** `"src/domain/ask.ts imports hono"` for every import in `folder` that `allowed` refuses. */
const offenders = async (folder: string, allowed: (specifier: string, file: string) => boolean) => {
	const found: string[] = [];
	for (const file of await filesIn(folder)) {
		for (const specifier of await importsOf(file)) {
			if (!allowed(specifier, file)) found.push(`${relative(".", file)} imports ${specifier}`);
		}
	}
	return found;
};

const isRelative = (specifier: string) => specifier.startsWith(".");

describe("the server's layers", () => {
	// A rule over a folder that does not exist passes by matching nothing: a renamed layer would
	// disarm every rule below without a word. So each must exist, and hold code.
	it.each(LAYERS)("include %s, with code in it", async (folder) => {
		expect((await filesIn(folder)).length).toBeGreaterThan(0);
	});

	it("keep the domain to itself", async () => {
		const violations = await projectFiles()
			.inFolder("src/domain/**")
			.shouldNot()
			.dependOnFiles()
			.inFolder("src/{space,worker,generated}/**")
			.check();
		expect(violations).toEqual([]);
	});

	it("keep the core out of the edge", async () => {
		const violations = await projectFiles()
			.inFolder("src/space/**")
			.shouldNot()
			.dependOnFiles()
			.inFolder("src/{worker,generated}/**")
			.check();
		expect(violations).toEqual([]);
	});

	it("have no import cycles", async () => {
		expect(await projectFiles().inFolder("src/**").should().haveNoCycles().check()).toEqual([]);
	});

	it("let the domain import only Effect and the protocol's types", async () => {
		expect(
			await offenders(
				"src/domain",
				(specifier) =>
					isRelative(specifier) || specifier === "effect" || specifier === "@loopbackhq/protocol",
			),
		).toEqual([]);
	});

	it("keep the core free of HTTP, MCP, tokens and request validation", async () => {
		const edge = /^(hono|@hono\/|@modelcontextprotocol\/|jose$|zod$|secure-json-parse$)/;
		expect(await offenders("src/space", (specifier) => !edge.test(specifier))).toEqual([]);
	});

	it("reach the runtime from the core only where the Durable Object lives", async () => {
		expect(
			await offenders(
				"src/space",
				(specifier, file) => !specifier.startsWith("cloudflare:") || file === "src/space/object.ts",
			),
		).toEqual([]);
		expect(
			await offenders("src/domain", (specifier) => !specifier.startsWith("cloudflare:")),
		).toEqual([]);
	});
});
