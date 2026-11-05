import { Effect, Schema } from "effect";
import { Command, Port } from "foldkit";
import { AdminUi } from "#/platform/admin-ui.ts";
import { saveConfiguration } from "#/platform/configuration-api.ts";
import { Message } from "#/features/configuration/message.ts";
import { ports } from "#/features/configuration/ports.ts";

export const PickProducts = Command.define("PickProducts", {
	args: { selectedIds: Schema.Array(Schema.String) },
	messages: [Message.PickedProducts, Message.CancelledPickProducts, Message.FailedPickProducts],
	execute: ({ selectedIds }) =>
		AdminUi.use((admin) =>
			admin.pickProducts(selectedIds).pipe(
				Effect.map((outcome) =>
					outcome._tag === "Cancelled"
						? Message.CancelledPickProducts()
						: Message.PickedProducts({ ids: outcome.ids }),
				),
				Effect.catch((error) => Effect.succeed(Message.FailedPickProducts({ error }))),
			),
		),
});

export const SaveConfiguration = Command.define("SaveConfiguration", {
	args: {
		title: Schema.String,
		productIds: Schema.Array(Schema.String),
		revision: Schema.Number,
	},
	messages: [Message.SucceededSave, Message.FailedSave],
	execute: ({ title, productIds, revision }) =>
		saveConfiguration({ title, productIds }).pipe(
			Effect.map((saved) =>
				Message.SucceededSave({
					title: saved.title,
					productIds: saved.productIds,
					revision,
				}),
			),
			Effect.catch((error) => Effect.succeed(Message.FailedSave({ error, revision }))),
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
	messages: [Message.CompletedNavigation, Message.StayedForNavigation],
	execute: ({ href }) =>
		AdminUi.use((admin) =>
			admin.confirmLeave().pipe(
				Effect.flatMap(() =>
					Port.emit(ports.outbound.navigationRequested, href).pipe(
						Effect.as(Message.CompletedNavigation()),
					),
				),
				Effect.catch(() => Effect.succeed(Message.StayedForNavigation())),
			),
		),
});
