import type { ComponentChildren, HTMLAttributes, TargetedMouseEvent } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router, useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";

export function App() {
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
				<Link href="/dashboard">Return to the dashboard</Link>
			</s-section>
		</s-page>
	);
}

interface LinkProps extends Omit<HTMLAttributes<HTMLAnchorElement>, "href"> {
	href: string;
	children: ComponentChildren;
}

// Client-side nav via preact-iso preserves App Bridge + iframe state. Modifier
// clicks still hard-navigate (Shopify recreates the embed from query params).
function Link({ href, onClick, children, ...rest }: LinkProps) {
	const { route } = useLocation();

	function handleClick(event: TargetedMouseEvent<HTMLAnchorElement>) {
		if (onClick) onClick(event);
		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		if (event.button !== 0) return;
		event.preventDefault();
		route(href);
	}

	return (
		<a href={href} onClick={handleClick} {...rest}>
			{children}
		</a>
	);
}
