import { ShikiProvider } from "@cloudflare/kumo/code";
import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { followSystemTheme } from "./theme.ts";

/** The languages review code is highlighted in; anything else is shown plain. */
const LANGUAGES = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"json",
	"html",
	"css",
	"python",
	"bash",
	"yaml",
	"toml",
	"sql",
	"markdown",
	"graphql",
	"hcl",
	"diff",
] as const;

followSystemTheme();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

createRoot(root).render(
	<StrictMode>
		<RegistryProvider>
			<ShikiProvider engine="javascript" languages={[...LANGUAGES]}>
				<App />
			</ShikiProvider>
		</RegistryProvider>
	</StrictMode>,
);
