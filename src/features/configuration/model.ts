import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

export const Configuration = Schema.Struct({
	title: Schema.String,
	productIds: Schema.Array(Schema.String),
});
export type Configuration = typeof Configuration.Type;

export const Picker = defineTaggedUnion({
	Closed: {},
	Opening: {},
	Failed: { error: Schema.String },
});
export type Picker = typeof Picker.Type;

export const Save = defineTaggedUnion({
	Idle: {},
	Saving: { revision: Schema.Number },
	Failed: { error: Schema.String },
});
export type Save = typeof Save.Type;

export const Model = Schema.Struct({
	saved: Configuration,
	draft: Configuration,
	picker: Picker,
	save: Save,
	revision: Schema.Number,
	showValidation: Schema.Boolean,
	platformError: Schema.String,
});
export type Model = typeof Model.Type;

export interface ConfigurationFlags {
	title: string;
	productIds: readonly string[];
}

export const Flags = Schema.Struct({
	title: Schema.String,
	productIds: Schema.Array(Schema.String),
});
export type Flags = typeof Flags.Type;

export function copyConfiguration(record: ConfigurationFlags): Configuration {
	return { title: record.title, productIds: [...record.productIds] };
}

export function sameConfiguration(left: Configuration, right: Configuration) {
	if (left.title !== right.title || left.productIds.length !== right.productIds.length) return false;
	return left.productIds.every((id, index) => id === right.productIds[index]);
}

export function isDirty(model: Model) {
	return !sameConfiguration(model.draft, model.saved);
}

export function titleError(title: string) {
	if (title.trim().length === 0) return "Enter a configuration name.";
	if (title.length > 120) return "Use 120 characters or fewer.";
	return undefined;
}

export function initialModel(flags: ConfigurationFlags): Model {
	const saved = copyConfiguration(flags);
	return {
		saved,
		draft: copyConfiguration(flags),
		picker: Picker.Closed(),
		save: Save.Idle(),
		revision: 0,
		showValidation: false,
		platformError: "",
	};
}
