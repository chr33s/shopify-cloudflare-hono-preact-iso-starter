import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Product } from "#/features/configuration/model.ts";

export const Message = defineMessageUnion({
	UpdatedTitle: { value: Schema.String },
	ClickedPickProducts: {},
	SucceededPickProducts: { products: Schema.Option(Schema.Array(Product)) },
	FailedPickProducts: { error: Schema.String },
	ClickedSave: {},
	SucceededSaveConfiguration: {
		title: Schema.String,
		products: Schema.Array(Product),
		revision: Schema.Number,
		savedRevision: Schema.Number,
	},
	FailedSaveConfiguration: { error: Schema.String, revision: Schema.Number },
	ClickedDiscard: {},
	ClickedBack: {},
	CompletedPlatform: {},
	FailedPlatform: { error: Schema.String },
	CompletedNavigation: {},
	StayedForNavigation: {},
});
export type Message = typeof Message.Type;
