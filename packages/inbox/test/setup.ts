import "@testing-library/jest-dom/vitest";

// Kumo's tabs measure where their indicator goes; jsdom has no layout to observe.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

// Nor can it scroll, which Kumo's tabs do to bring the picked one into view.
if (!("scrollIntoView" in Element.prototype)) {
	Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {} });
}
