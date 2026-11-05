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
	pickProducts: Effect.fn("AdminUi.pickProducts")(function* (
		selectedIds: ReadonlyArray<string>,
	): Effect.fn.Return<PickerOutcome, string> {
		const selection = yield* Effect.tryPromise({
			try: () =>
				bridge().resourcePicker({
					type: "product",
					action: "select",
					multiple: true,
					filter: { variants: false },
					selectionIds: selectedIds.map((id) => ({ id })),
				}),
			catch: asError,
		});
		if (selection === undefined) {
			return { _tag: "Cancelled" } as const;
		}
		const products = yield* Schema.decodeUnknownEffect(Schema.Array(PickerProduct))(selection).pipe(
			Effect.mapError(() => "The product picker returned an unexpected selection."),
		);
		return {
			_tag: "Picked" as const,
			products: products.map((product) => ({
				id: product.id,
				title: product.title?.trim() ? product.title.trim() : product.id,
			})),
		};
	}),
	showToast: Effect.fn("AdminUi.showToast")(function* (
		message: string,
		isError: boolean,
	): Effect.fn.Return<void, string> {
		yield* Effect.tryPromise({
			try: async () => {
				bridge().toast.show(message, { isError });
			},
			catch: asError,
		});
	}),
	showSaveBar: Effect.fn("AdminUi.showSaveBar")(function* (): Effect.fn.Return<void, string> {
		yield* Effect.tryPromise({
			try: () => bridge().saveBar.show(SAVE_BAR_ID),
			catch: asError,
		});
	}),
	hideSaveBar: Effect.fn("AdminUi.hideSaveBar")(function* (): Effect.fn.Return<void, string> {
		yield* Effect.tryPromise({
			try: () => bridge().saveBar.hide(SAVE_BAR_ID),
			catch: asError,
		});
	}),
	confirmLeave: Effect.fn("AdminUi.confirmLeave")(function* (): Effect.fn.Return<void, LeaveError> {
		yield* Effect.tryPromise({
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
		});
	}),
});
