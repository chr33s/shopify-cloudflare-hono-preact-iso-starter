import { ErrorBoundary } from "preact-iso";
import { LocationProvider, Route, Router, useLocation } from "preact-iso/router/navigation-api";
import { useEffect, useState } from "preact/hooks";

export function App() {
	useShopifyNavigation();

	return (
		<LocationProvider>
			<ErrorBoundary>
				<Router>
					<Route path="/" component={Home} />
					<Route path="/dashboard" component={Dashboard} />
					<Route default component={NotFound} />
				</Router>
			</ErrorBoundary>
		</LocationProvider>
	);
}

function useShopifyNavigation() {
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
			// App Bridge's patched navigation.navigate() resolves its target with
			// `new URL(href)` (no base), so it needs an absolute URL — a relative
			// path throws "Invalid URL" and the navigation silently no-ops.
			window.navigation.navigate(url.href);
		}

		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);
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
			<s-app-nav>
				<s-link href="/" {...{ rel: "home" }}>
					Home
				</s-link>
				<s-link href="/dashboard">Dashboard</s-link>
			</s-app-nav>

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
			<s-section>
				<s-paragraph>That page does not exist.</s-paragraph>
				<s-link href="/dashboard">Return to the dashboard</s-link>
			</s-section>
		</s-page>
	);
}
