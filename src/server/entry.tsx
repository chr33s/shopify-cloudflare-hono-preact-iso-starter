import { prerender } from "preact-iso";
import { locationStub } from "preact-iso/prerender";
import { App } from "../client/app.tsx";

export async function renderApp(url: string) {
	// preact-iso's router needs a browser-like location during SSR.
	locationStub(url);

	const { html } = await prerender(<App />);
	return html;
}
