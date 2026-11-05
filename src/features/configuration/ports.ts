import { Schema } from "effect";
import { Port } from "foldkit";

export const ports = {
	outbound: {
		navigationRequested: Port.outbound(Schema.String),
	},
};
