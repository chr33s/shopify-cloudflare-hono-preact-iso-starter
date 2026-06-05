import { describe, expect, it } from "vitest";
import { renderApp } from "../server/entry.tsx";

describe("renderApp", () => {
	it("SSRs the install page at /", async () => {
		const html = await renderApp("/");
		expect(html).toContain('heading="Install"');
		expect(html).toContain("Install this app on your Shopify store");
		expect(html).toContain('action="/shopify/install"');
	});

	it("surfaces the INVALID_SHOP error banner via the query string", async () => {
		const html = await renderApp("/?error=INVALID_SHOP");
		expect(html).toContain("Enter a valid Shopify store domain");
	});

	it("SSRs the dashboard shell at /dashboard", async () => {
		const html = await renderApp("/dashboard");
		expect(html).toContain('heading="Dashboard"');
		expect(html).toContain("<s-app-nav");
		// Effects don't run during SSR, so the shop data fetch hasn't resolved yet.
		expect(html).toContain("<s-spinner");
	});

	it("renders the not-found route for unknown paths", async () => {
		const html = await renderApp("/does-not-exist");
		expect(html).toContain('heading="Not found"');
		expect(html).toContain("That page does not exist.");
	});
});
