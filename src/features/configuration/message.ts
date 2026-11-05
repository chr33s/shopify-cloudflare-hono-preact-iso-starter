import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const Message = defineMessageUnion({
	ChangedTitle: { value: Schema.String },
	ClickedPickProducts: {},
	PickedProducts: { ids: Schema.Array(Schema.String) },
	CancelledPickProducts: {},
	FailedPickProducts: { error: Schema.String },
	ClickedSave: {},
	SucceededSave: {
		title: Schema.String,
		productIds: Schema.Array(Schema.String),
		revision: Schema.Number,
	},
	FailedSave: { error: Schema.String, revision: Schema.Number },
	ClickedDiscard: {},
	ClickedBack: {},
	CompletedPlatform: {},
	FailedPlatform: { error: Schema.String },
	CompletedNavigation: {},
	StayedForNavigation: {},
});
export type Message = typeof Message.Type;
