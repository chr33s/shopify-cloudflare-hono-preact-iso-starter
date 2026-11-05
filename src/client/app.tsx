import { ErrorBoundary } from "preact-iso";
import { LocationProvider, Route, Router, useLocation } from "preact-iso/router";
import { useEffect, useState } from "preact/hooks";
import { ConfigurationRoute } from "#/client/configuration-route.tsx";
import { AppNav } from "#/client/app-nav.tsx";

export function App() {
	return (
		<LocationProvider>
			<ErrorBoundary>
				<ShopifyNavigation />
				<Router>
					<Route path="/" component={Home} />
					<Route path="/dashboard" component={Dashboard} />
					<Route path="/configuration" component={ConfigurationRoute} />
					<Route default component={NotFound} />
				</Router>
			</ErrorBoundary>
		</LocationProvider>
	);
}

function ShopifyNavigation() {
	const { route } = useLocation();

	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (
				e.defaultPrevented ||
				e.button !== 0 ||
				e.metaKey ||
				e.ctrlKey ||
				e.shiftKey ||
				e.altKey
			) {
				return;
			}

			const path = e.composedPath();
			// App Bridge owns s-app-nav navigation (it also syncs the admin chrome),
			// so leave its links alone — intercept only in-body links.
			if (path.some((n) => n instanceof HTMLElement && n.localName === "s-app-nav")) return;

			const el = path.find(
				(n): n is HTMLElement =>
					n instanceof HTMLElement &&
					/^s-(link|button|clickable)$/i.test(n.localName) &&
					n.hasAttribute("href"),
			);
			if (!el) return;

			const target = el.getAttribute("target");
			if (target && target !== "_self" && target !== "auto") return;

			const url = new URL(el.getAttribute("href")!, location.origin);
			if (url.origin !== location.origin) return;

			e.preventDefault();
			e.stopImmediatePropagation();
			const destination = url.pathname + url.search + url.hash;
			void confirmLeave().then(
				() => route(destination),
				() => {},
			);
		}

		// App Bridge updates the parent admin URL for s-app-nav links and fires
		// shopify:navigate, but doesn't move the inner iframe — do it ourselves.
		function onShopifyNavigate(e: Event) {
			const href = (e.target as Element | null)?.getAttribute?.("href");
			if (!href) return;
			let dest: URL;
			try {
				dest = new URL(href, location.origin);
			} catch {
				return;
			}
			if (dest.origin !== location.origin) return;
			if (dest.pathname + dest.search === location.pathname + location.search) return;
			const destination = dest.pathname + dest.search + dest.hash;
			void confirmLeave().then(
				() => route(destination),
				() => {},
			);
		}

		document.addEventListener("click", onClick, true);
		document.addEventListener("shopify:navigate", onShopifyNavigate);
		return () => {
			document.removeEventListener("click", onClick, true);
			document.removeEventListener("shopify:navigate", onShopifyNavigate);
		};
	}, [route]);

	return null;
}

function confirmLeave() {
	const saveBar = globalThis.shopify?.saveBar;
	if (!saveBar) return Promise.resolve();
	return saveBar.leaveConfirmation();
}


function Home() {
	const { query } = useLocation();

	const errorMessages: Record<string, string> = {
		INVALID_SHOP: "Enter a valid Shopify store domain or admin.shopify.com/store/... URL.",
	};
	const errorMessage = query.error ? errorMessages[query.error] : null;

	return (
		<s-page heading="Install" inlineSize="small">
			<form action="/shopify/install" method="get">
				<s-stack gap="base">
					<s-paragraph>Install this app on your Shopify store to get started.</s-paragraph>

					{errorMessage ? <s-banner tone="warning">{errorMessage}</s-banner> : null}

					<s-stack gap="base" maxInlineSize="75%">
						<s-text-field
							label="Shopify store"
							name="shop"
							placeholder="your-store.myshopify.com"
							details="Accepts shop handles, full store domains, and Shopify admin URLs."
							required
						/>
						<s-button type="submit" variant="primary">
							Install app
						</s-button>
					</s-stack>
				</s-stack>
			</form>
		</s-page>
	);
}

interface ShopResponse {
	data?: { shop?: { name: string; myshopifyDomain: string } };
}

function Dashboard() {
	const [shop, setShop] = useState<ShopResponse["data"] | undefined>();
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		void fetch("/shopify/admin", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: `#graphql
          query Shop {
            shop {
              name
              myshopifyDomain
            }
          }
        `,
				variables: {},
			}),
		})
			.then<ShopResponse>((response) => response.json())
			.then((result) => setShop(result.data))
			.catch((cause) => setError(String(cause)));
	}, []);

	return (
		<s-page heading="Dashboard">
			<AppNav />

			<s-stack slot="secondary-actions">Action</s-stack>

			<s-section heading="Shop">
				{error ? <s-banner tone="critical">{error}</s-banner> : null}
				{shop?.shop ? (
					<s-stack gap="base">
						<s-text>Name: {shop.shop.name}</s-text>
						<s-text>Domain: {shop.shop.myshopifyDomain}</s-text>
					</s-stack>
				) : (
					<s-spinner accessibilityLabel="Loading shop" />
				)}
			</s-section>
		</s-page>
	);
}

function NotFound() {
	return (
		<s-page heading="Not found">
			<AppNav />
			<s-section>
				<s-paragraph>That page does not exist.</s-paragraph>
				<s-link href="/dashboard">Return to the dashboard</s-link>
			</s-section>
		</s-page>
	);
}
