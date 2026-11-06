import { Schema } from "effect";

// Wire record for GET and PUT /api/configuration. Write validation stays in
// parseConfigurationWrite so caller-facing messages are not schema issues.
export const Product = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});
export interface Product extends Schema.Schema.Type<typeof Product> {}

export const ConfigurationRecord = Schema.Struct({
	title: Schema.String,
	products: Schema.Array(Product),
	revision: Schema.Number,
});
export interface ConfigurationRecord extends Schema.Schema.Type<typeof ConfigurationRecord> {}
