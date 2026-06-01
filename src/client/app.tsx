import type { ComponentChildren } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router, useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";

export function App() {
	return (
		<LocationProvider>
			<AppProvider>
				<ErrorBoundary>
					<Router>
						<Route path="/" component={Home} />
						<Route path="/dashboard" component={Dashboard} />
						<Route default component={NotFound} />
					</Router>
				</ErrorBoundary>
			</AppProvider>
		</LocationProvider>
	);
}

function AppProvider(props: { children: ComponentChildren }) {
	const { route } = useLocation();

	useEffect(() => {
		const handleNavigate = (event: Event) => {
			const target = event.target as HTMLElement | null;
			if (!target) return;

			const href = target.getAttribute("href");
			if (!href) return;

			const targetAttr = target.getAttribute("target");
			if (targetAttr && targetAttr !== "_self" && targetAttr !== "auto") return;

			const url = new URL(href, window.location.origin);
			if (!/^https?:$/i.test(url.protocol) || url.origin !== window.location.origin) return;
			if (!url.pathname.startsWith("/app")) return;

			route(url.pathname + url.search + url.hash);
		};

		document.addEventListener("shopify:navigate", handleNavigate);
		return () => document.removeEventListener("shopify:navigate", handleNavigate);
	}, [route]);

	return props.children;
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
