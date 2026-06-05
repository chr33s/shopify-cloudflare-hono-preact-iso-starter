import { describe, expect, it } from "vitest";

describe("client entry", () => {
	it("hydrates <App /> into the #app container", async () => {
		window.history.replaceState(null, "", "/");
		document.body.innerHTML = '<div id="app"></div>';

		await import("../client/entry.tsx");

		const app = document.getElementById("app");
		expect(app).not.toBeNull();
		expect(app?.querySelector("s-page")).not.toBeNull();
	});
});
