import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.tsx";
import { tokenAtom } from "../src/web/session.ts";

/** A server that answers `whoami` with `status`, and refuses everything else. */
const serving = (whoami: number) => {
	const seen: { url: string; authorization: string | null }[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		seen.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
		return url.endsWith("/api/v1/whoami") && whoami === 200
			? Response.json({ space: "default" })
			: Response.json({ code: "auth.unauthorized", message: "No." }, { status: 401 });
	});
	return seen;
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("signing in", () => {
	it("opens the inbox at once when the page's host has signed the person in", async () => {
		const seen = serving(200);
		render(
			<RegistryProvider initialValues={[[tokenAtom, null]]}>
				<App />
			</RegistryProvider>,
		);
		expect(await screen.findByText("Connecting")).toBeInTheDocument();
		expect(screen.queryByLabelText("Token")).toBeNull();
		// The host owns the session, so there is nothing here to sign out of.
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
		expect(seen.find((call) => call.url.endsWith("/whoami"))?.authorization).toBeNull();
	});

	it("asks for the token when nothing has signed the person in", async () => {
		serving(401);
		render(
			<RegistryProvider initialValues={[[tokenAtom, null]]}>
				<App />
			</RegistryProvider>,
		);
		expect(await screen.findByLabelText("Token")).toBeInTheDocument();
	});
});
