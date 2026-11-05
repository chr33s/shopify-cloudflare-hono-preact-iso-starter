import { Option, Schema } from "effect";
import {
	Field,
	NotValidated,
	makeRules,
	validate,
	type Field as TitleField,
} from "foldkit/fieldValidation";
import { defineTaggedUnion } from "foldkit/schema";
import { MAX_PRODUCTS, MAX_TITLE_LENGTH, isProductGid } from "#/configuration/record.ts";

export const Product = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});
export type Product = typeof Product.Type;

export const Configuration = Schema.Struct({
	title: Schema.String,
	products: Schema.Array(Product),
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

export const titleRules = makeRules({
	required: "Enter a configuration name.",
	isEmpty: (value) => value.trim().length === 0,
	rules: [
		[
			(value) => value.trim().length <= MAX_TITLE_LENGTH,
			`Use ${MAX_TITLE_LENGTH} characters or fewer.`,
		],
	],
});

export const Model = Schema.Struct({
	saved: Configuration,
	draftTitle: Field(Schema.String),
	draftProducts: Schema.Array(Product),
	picker: Picker,
	save: Save,
	revision: Schema.Number,
	savedRevision: Schema.Number,
	maybePlatformError: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

export interface ConfigurationFlags {
	title: string;
	products: ReadonlyArray<Product>;
	revision: number;
}

export const Flags = Schema.Struct({
	title: Schema.String,
	products: Schema.Array(Product),
	revision: Schema.Number,
});
export type Flags = typeof Flags.Type;

export function copyProducts(products: ReadonlyArray<Product>): Array<Product> {
	return products.map((product) => ({ id: product.id, title: product.title }));
}

export function titleField(title: string): TitleField<string> {
	if (title.trim().length === 0) {
		return NotValidated({ value: title });
	}
	return validate(titleRules)(title);
}

export function sameProducts(left: ReadonlyArray<Product>, right: ReadonlyArray<Product>) {
	if (left.length !== right.length) {
		return false;
	}
	return left.every(
		(product, index) => product.id === right[index]?.id && product.title === right[index]?.title,
	);
}

export function isDirty(model: Model) {
	return (
		model.draftTitle.value.trim() !== model.saved.title.trim() ||
		!sameProducts(model.draftProducts, model.saved.products)
	);
}

export function productSelectionError(products: ReadonlyArray<Product>) {
	if (products.length > MAX_PRODUCTS) {
		return `Select ${MAX_PRODUCTS} products or fewer.`;
	}
	if (products.some((product) => !isProductGid(product.id))) {
		return "Product ids must be Shopify product GIDs.";
	}
	return undefined;
}

export function dedupeProducts(products: ReadonlyArray<Product>): Array<Product> {
	return products.reduce<Array<Product>>((unique, product) => {
		if (unique.some((existing) => existing.id === product.id)) {
			return unique;
		}
		return [...unique, { id: product.id, title: product.title }];
	}, []);
}

export function initialModel(flags: ConfigurationFlags): Model {
	return {
		saved: { title: flags.title, products: copyProducts(flags.products) },
		draftTitle: titleField(flags.title),
		draftProducts: copyProducts(flags.products),
		picker: Picker.Closed(),
		save: Save.Idle(),
		revision: 0,
		savedRevision: flags.revision,
		maybePlatformError: Option.none(),
	};
}
