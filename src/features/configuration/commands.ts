import { Effect, Option, Schema } from "effect";
import { Command, Port } from "foldkit";
import { Product } from "#/features/configuration/model.ts";
import { Message } from "#/features/configuration/message.ts";
import { ports } from "#/features/configuration/ports.ts";
import { AdminUi } from "#/platform/admin-ui.ts";
import { saveConfiguration } from "#/platform/configuration-api.ts";

export const PickProducts = Command.define("PickProducts", {
	args: { selectedIds: Schema.Array(Schema.String) },
	messages: [Message.SucceededPickProducts, Message.FailedPickProducts],
	execute: ({ selectedIds }) =>
		AdminUi.use((admin) =>
			admin.pickProducts(selectedIds).pipe(
				Effect.map((outcome) =>
					outcome._tag === "Cancelled"
						? Message.SucceededPickProducts({ products: Option.none() })
						: Message.SucceededPickProducts({ products: Option.some(outcome.products) }),
				),
				Effect.catch((error) => Effect.succeed(Message.FailedPickProducts({ error }))),
			),
		),
});

export const SaveConfiguration = Command.define("SaveConfiguration", {
	args: {
		title: Schema.String,
		products: Schema.Array(Product),
		revision: Schema.Number,
		expectedRevision: Schema.Number,
	},
	messages: [Message.SucceededSaveConfiguration, Message.FailedSaveConfiguration],
	execute: ({ title, products, revision, expectedRevision }) =>
		saveConfiguration({ title, products, expectedRevision }).pipe(
			Effect.map((saved) =>
				Message.SucceededSaveConfiguration({
					title: saved.title,
					products: saved.products,
					revision,
					savedRevision: saved.revision,
				}),
			),
			Effect.catch((error) => Effect.succeed(Message.FailedSaveConfiguration({ error, revision }))),
		),
});

export const ShowSaveBar = Command.define("ShowSaveBar", {
	messages: [Message.CompletedPlatform, Message.FailedPlatform],
	execute: AdminUi.use((admin) =>
		admin.showSaveBar().pipe(
			Effect.as(Message.CompletedPlatform()),
			Effect.catch((error) => Effect.succeed(Message.FailedPlatform({ error }))),
		),
	),
});

export const HideSaveBar = Command.define("HideSaveBar", {
	messages: [Message.CompletedPlatform, Message.FailedPlatform],
	execute: AdminUi.use((admin) =>
		admin.hideSaveBar().pipe(
			Effect.as(Message.CompletedPlatform()),
			Effect.catch((error) => Effect.succeed(Message.FailedPlatform({ error }))),
		),
	),
});

export const ShowToast = Command.define("ShowToast", {
	args: { message: Schema.String, isError: Schema.Boolean },
	messages: [Message.CompletedPlatform, Message.FailedPlatform],
	execute: ({ message, isError }) =>
		AdminUi.use((admin) =>
			admin.showToast(message, isError).pipe(
				Effect.as(Message.CompletedPlatform()),
				Effect.catch((error) => Effect.succeed(Message.FailedPlatform({ error }))),
			),
		),
});

export const RequestNavigation = Command.define("RequestNavigation", {
	args: { href: Schema.String },
	messages: [Message.CompletedNavigation, Message.StayedForNavigation, Message.FailedPlatform],
	execute: ({ href }) =>
		AdminUi.use((admin) =>
			admin.confirmLeave().pipe(
				Effect.flatMap(() =>
					Port.emit(ports.outbound.navigationRequested, href).pipe(
						Effect.as(Message.CompletedNavigation()),
					),
				),
				Effect.catch((error) =>
					Effect.succeed(
						error._tag === "Stayed"
							? Message.StayedForNavigation()
							: Message.FailedPlatform({ error: error.error }),
					),
				),
			),
		),
});
