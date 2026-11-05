export function AppNav() {
	return (
		<s-app-nav>
			<s-link href="/" {...{ rel: "home" }}>
				Home
			</s-link>
			<s-link href="/dashboard">Dashboard</s-link>
			<s-link href="/configuration">Configuration</s-link>
		</s-app-nav>
	);
}
