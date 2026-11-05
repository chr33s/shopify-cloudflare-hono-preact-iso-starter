import { Context, Effect } from "effect";
import { SAVE_BAR_ID } from "#/features/configuration/save-bar.ts";

export type PickerOutcome =
	| { readonly _tag: "Picked"; readonly ids: readonly string[] }
	| { readonly _tag: "Cancelled" };

export class AdminUi extends Context.Service<
	AdminUi,
	{
		readonly pickProducts: (selectedIds: readonly string[]) => Effect.Effect<PickerOutcome, string>;
		readonly showToast: (message: string, isError: boolean) => Effect.Effect<void, string>;
		readonly showSaveBar: () => Effect.Effect<void, string>;
		readonly hideSaveBar: () => Effect.Effect<void, string>;
		readonly confirmLeave: () => Effect.Effect<void, string>;
	}
>()("AdminUi") {}

interface ResourceSelection {
	id: string;
}

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
			try: async () => {
				const selection = (await bridge().resourcePicker({
					type: "product",
					action: "select",
					multiple: true,
					filter: { variants: false },
					selectionIds: selectedIds.map((id) => ({ id })),
				})) as ResourceSelection[] | undefined;

				if (selection === undefined) return { _tag: "Cancelled" } as const;
				return { _tag: "Picked", ids: selection.map((product) => product.id) } as const;
			},
			catch: asError,
		}),
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
			try: () => bridge().saveBar.leaveConfirmation(),
			catch: asError,
		}),
});
