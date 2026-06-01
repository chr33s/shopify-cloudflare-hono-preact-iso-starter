import type {
	SAppNavAttributes,
	SAppWindowAttributes,
	UIModalAttributes,
	UINavMenuAttributes,
	UISaveBarAttributes,
	UITitleBarAttributes,
} from "@shopify/app-bridge-types";

// @shopify/app-bridge-types only augments the global JSX namespace, but preact
// (with jsxImportSource: "preact") consults its own createElement.JSX namespace.
// Bridge the App Bridge tags into preact's namespace so they're typed for the
// admin app.
declare module "preact" {
	namespace createElement.JSX {
		interface IntrinsicElements {
			"s-app-nav": SAppNavAttributes;
			"s-app-window": SAppWindowAttributes;
			"ui-modal": UIModalAttributes;
			"ui-nav-menu": UINavMenuAttributes;
			"ui-save-bar": UISaveBarAttributes;
			"ui-title-bar": UITitleBarAttributes;
		}
	}
}
