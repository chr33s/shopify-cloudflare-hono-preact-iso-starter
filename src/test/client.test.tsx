import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { App } from "../client/app.tsx";

describe("App", () => {
	it("renders the Polaris install page at /", () => {
		window.history.replaceState(null, "", "/");

		const { container } = render(<App />);

		const page = container.querySelector("s-page");
		expect(page).not.toBeNull();
		expect(page?.getAttribute("heading")).toBe("Install");
		expect(container.querySelector('form[action="/shopify/install"]')).not.toBeNull();
		expect(container.querySelector('s-text-field[name="shop"]')).not.toBeNull();
	});

	it("renders the not-found route for unknown paths", () => {
		window.history.replaceState(null, "", "/does-not-exist");

		const { container } = render(<App />);

		expect(container.querySelector("s-page")?.getAttribute("heading")).toBe("Not found");
		expect(container.textContent).toContain("That page does not exist.");
	});
});
