import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso/router";
import { Effect } from "effect";
import { Runtime } from "foldkit";
import { AppNav } from "#/client/app-nav.tsx";
import { loadConfiguration } from "#/platform/configuration-api.ts";
import { makeConfigurationElement } from "#/features/configuration/program.ts";
import { SAVE_BAR_ID } from "#/features/configuration/save-bar.ts";

export function ConfigurationRoute() {
	const { route } = useLocation();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const routeRef = useRef(route);
	routeRef.current = route;
	const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
	const [loadError, setLoadError] = useState("");

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (host === null) return;

		const mount = document.createElement("div");
		host.appendChild(mount);

		let active = true;
		let unsubscribe = () => {};
		let dispose = () => {};

		void Effect.runPromise(loadConfiguration()).then(
			(flags) => {
				if (!active) return;
				const handle = Runtime.embed(makeConfigurationElement(mount, flags));
				dispose = () => handle.dispose();
				unsubscribe = handle.ports.navigationRequested.subscribe((href) => {
					routeRef.current(href);
				});
				setPhase("ready");
			},
			(error: unknown) => {
				if (!active) return;
				setLoadError(error instanceof Error ? error.message : String(error));
				setPhase("error");
			},
		);

		return () => {
			active = false;
			unsubscribe();
			const saveBar = globalThis.shopify?.saveBar;
			if (saveBar !== undefined) {
				void saveBar.hide(SAVE_BAR_ID);
			}
			dispose();
			host.replaceChildren();
		};
	}, []);

	return (
		<s-page heading="Product configuration">
			<AppNav />
			<s-section heading="Editor">
				{phase === "loading" ? <s-spinner accessibilityLabel="Loading configuration" /> : null}
				{phase === "error" ? <s-banner tone="critical">{loadError}</s-banner> : null}
				<div ref={hostRef} />
			</s-section>
		</s-page>
	);
}
