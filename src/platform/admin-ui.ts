import { Context, Effect, Schema } from "effect";
import { SAVE_BAR_ID } from "#/features/configuration/save-bar.ts";
import type { Product } from "#/features/configuration/model.ts";

export type PickerOutcome =
	| { readonly _tag: "Picked"; readonly products: ReadonlyArray<Product> }
	| { readonly _tag: "Cancelled" };

export type LeaveError =
	| { readonly _tag: "Stayed" }
	| { readonly _tag: "Unavailable"; readonly error: string };

export class AdminUi extends Context.Service<
	AdminUi,
	{
		readonly pickProducts: (
			selectedIds: ReadonlyArray<string>,
		) => Effect.Effect<PickerOutcome, string>;
		readonly showToast: (message: string, isError: boolean) => Effect.Effect<void, string>;
		readonly showSaveBar: () => Effect.Effect<void, string>;
		readonly hideSaveBar: () => Effect.Effect<void, string>;
		readonly confirmLeave: () => Effect.Effect<void, LeaveError>;
	}
>()("AdminUi") {}

const PickerProduct = Schema.Struct({
	id: Schema.String,
	title: Schema.optional(Schema.String),
});

function bridge() {
	const shopifyGlobal = globalThis.shopify;
	if (!shopifyGlobal) {
		throw new Error("App Bridge is not available");
	}
	return shopifyGlobal;
}

function asError(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

export const liveAdminUi = AdminUi.of({
	pickProducts: (selectedIds) =>
		Effect.tryPromise({
			try: () =>
				bridge().resourcePicker({
					type: "product",
					action: "select",
					multiple: true,
					filter: { variants: false },
					selectionIds: selectedIds.map((id) => ({ id })),
				}),
			catch: asError,
		}).pipe(
			Effect.flatMap((selection): Effect.Effect<PickerOutcome, string> => {
				if (selection === undefined) {
					return Effect.succeed({ _tag: "Cancelled" });
				}
				return Schema.decodeUnknownEffect(Schema.Array(PickerProduct))(selection).pipe(
					Effect.map(
						(products): PickerOutcome => ({
							_tag: "Picked",
							products: products.map((product) => ({
								id: product.id,
								title: product.title?.trim() ? product.title.trim() : product.id,
							})),
						}),
					),
					Effect.mapError(() => "The product picker returned an unexpected selection."),
				);
			}),
		),
	showToast: (message, isError) =>
		Effect.tryPromise({
			try: async () => {
				bridge().toast.show(message, { isError });
			},
			catch: asError,
		}),
	showSaveBar: () =>
		Effect.tryPromise({
			try: () => bridge().saveBar.show(SAVE_BAR_ID),
			catch: asError,
		}),
	hideSaveBar: () =>
		Effect.tryPromise({
			try: () => bridge().saveBar.hide(SAVE_BAR_ID),
			catch: asError,
		}),
	confirmLeave: () =>
		Effect.tryPromise({
			try: () => {
				const leaveConfirmation = globalThis.shopify?.saveBar?.leaveConfirmation;
				if (!leaveConfirmation) {
					throw Object.assign(new Error("App Bridge is not available"), { unavailable: true });
				}
				return leaveConfirmation();
			},
			catch: (cause): LeaveError => {
				if (cause instanceof Error && "unavailable" in cause) {
					return { _tag: "Unavailable", error: cause.message };
				}
				return { _tag: "Stayed" };
			},
		}),
});
