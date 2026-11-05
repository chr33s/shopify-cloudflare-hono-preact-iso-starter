import { Schema } from "effect";
import { CustomElement } from "foldkit";

// Property factories write DOM properties. String attributes such as variant,
// slot, and tone stay on the view via h.Attribute so "false" is never stringified
// into a boolean property.

export const TextField = CustomElement.define({
	tag: "s-text-field",
	properties: {
		label: Schema.String,
		value: Schema.String,
		disabled: Schema.Boolean,
		error: Schema.String,
		details: Schema.String,
	},
	events: {},
});

export const Button = CustomElement.define({
	tag: "s-button",
	properties: {
		disabled: Schema.Boolean,
		loading: Schema.Boolean,
	},
	events: {},
});

export const Banner = CustomElement.define({
	tag: "s-banner",
	properties: {},
	events: {},
});

export const Stack = CustomElement.define({
	tag: "s-stack",
	properties: {
		gap: Schema.String,
	},
	events: {},
});

export const Text = CustomElement.define({
	tag: "s-text",
	properties: {},
	events: {},
});

export const Paragraph = CustomElement.define({
	tag: "s-paragraph",
	properties: {},
	events: {},
});

export const Section = CustomElement.define({
	tag: "s-section",
	properties: {
		heading: Schema.String,
	},
	events: {},
});

export const SaveBar = CustomElement.define({
	tag: "ui-save-bar",
	properties: {},
	events: {},
});
