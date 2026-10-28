/** Kumo themes by `data-mode` on the root element, so it follows the system's light or dark setting. */
export const followSystemTheme = () => {
	const dark = window.matchMedia("(prefers-color-scheme: dark)");
	const apply = () =>
		document.documentElement.setAttribute("data-mode", dark.matches ? "dark" : "light");
	apply();
	dark.addEventListener("change", apply);
};
