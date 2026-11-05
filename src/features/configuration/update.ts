import { Array, Option } from "effect";
import { Update } from "foldkit";
import { isValid, validate } from "foldkit/fieldValidation";
import { modifyFields } from "foldkit/struct";
import {
	HideSaveBar,
	PickProducts,
	RequestNavigation,
	SaveConfiguration,
	ShowSaveBar,
	ShowToast,
} from "#/features/configuration/commands.ts";
import { Message } from "#/features/configuration/message.ts";
import {
	Picker,
	Save,
	dedupeProducts,
	isDirty,
	productSelectionError,
	titleField,
	titleRules,
	type Model,
} from "#/features/configuration/model.ts";
import type { AdminUi } from "#/platform/admin-ui.ts";

type UpdateReturn = Update.Return<Model, Message, AdminUi>;
type Commands = Update.Commands<Message, AdminUi>;

function wantsSaveBar(model: Model) {
	if (model.save._tag === "Saving") {
		return true;
	}
	return isDirty(model);
}

function saveBarCommands(before: Model, after: Model): Commands | undefined {
	const wasOpen = wantsSaveBar(before);
	const nowOpen = wantsSaveBar(after);
	if (!wasOpen && nowOpen) {
		return [ShowSaveBar()];
	}
	if (wasOpen && !nowOpen) {
		return [HideSaveBar()];
	}
	return undefined;
}

function withCommands(model: Model, commands: Commands | undefined): UpdateReturn {
	if (commands === undefined) {
		return { model };
	}
	return { model, commands };
}

const clearPlatformError = () => Option.none<string>();

export const update = (model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		UpdatedTitle: ({ value }) => {
			const next = modifyFields(model, {
				draftTitle: () => validate(titleRules)(value),
				maybePlatformError: clearPlatformError,
			});
			return withCommands(next, saveBarCommands(model, next));
		},
		ClickedPickProducts: () => {
			if (model.picker._tag === "Opening") {
				return { model };
			}
			return {
				model: modifyFields(model, {
					picker: () => Picker.Opening(),
					maybePlatformError: clearPlatformError,
				}),
				commands: [
					PickProducts({ selectedIds: Array.map(model.draftProducts, (product) => product.id) }),
				],
			};
		},
		SucceededPickProducts: ({ products }) => {
			if (model.picker._tag !== "Opening") {
				return { model };
			}
			return Option.match(products, {
				onNone: () => ({
					model: modifyFields(model, { picker: () => Picker.Closed() }),
				}),
				onSome: (selected) => {
					const unique = dedupeProducts(selected);
					const error = productSelectionError(unique);
					if (error !== undefined) {
						return {
							model: modifyFields(model, {
								picker: () => Picker.Failed({ error }),
							}),
						};
					}
					const next = modifyFields(model, {
						draftProducts: () => unique,
						picker: () => Picker.Closed(),
					});
					return withCommands(next, saveBarCommands(model, next));
				},
			});
		},
		FailedPickProducts: ({ error }) => {
			if (model.picker._tag !== "Opening") {
				return { model };
			}
			return {
				model: modifyFields(model, { picker: () => Picker.Failed({ error }) }),
			};
		},
		ClickedSave: () => {
			if (model.save._tag === "Saving" || model.picker._tag === "Opening") {
				return { model };
			}
			const draftTitle = validate(titleRules)(model.draftTitle.value);
			if (!isValid(titleRules)(draftTitle)) {
				return { model: modifyFields(model, { draftTitle: () => draftTitle }) };
			}
			if (!isDirty(model)) {
				return { model };
			}

			const revision = model.revision + 1;
			return {
				model: modifyFields(model, {
					revision: () => revision,
					save: () => Save.Saving({ revision }),
					draftTitle: () => draftTitle,
					maybePlatformError: clearPlatformError,
				}),
				commands: [
					SaveConfiguration({
						title: model.draftTitle.value.trim(),
						products: model.draftProducts,
						revision,
						expectedRevision: model.savedRevision,
					}),
				],
			};
		},
		SucceededSaveConfiguration: ({ title, products, revision, savedRevision }) => {
			if (model.save._tag !== "Saving" || model.save.revision !== revision) {
				return { model };
			}
			const nextTitle =
				model.draftTitle.value.trim() === title ? titleField(title) : model.draftTitle;
			const next = modifyFields(model, {
				saved: () => ({ title, products: dedupeProducts(products) }),
				draftTitle: () => nextTitle,
				save: () => Save.Idle(),
				savedRevision: () => savedRevision,
			});
			const toast = ShowToast({ message: "Configuration saved", isError: false });
			const commands: Commands = isDirty(next) ? [toast, ShowSaveBar()] : [toast, HideSaveBar()];
			return { model: next, commands };
		},
		FailedSaveConfiguration: ({ error, revision }) => {
			if (model.save._tag !== "Saving" || model.save.revision !== revision) {
				return { model };
			}
			return {
				model: modifyFields(model, { save: () => Save.Failed({ error }) }),
				commands: [ShowToast({ message: error, isError: true })],
			};
		},
		ClickedDiscard: () => {
			if (model.save._tag === "Saving" || model.picker._tag === "Opening") {
				return { model };
			}
			const next = modifyFields(model, {
				draftTitle: () => titleField(model.saved.title),
				draftProducts: () => dedupeProducts(model.saved.products),
				picker: () => Picker.Closed(),
				save: () => Save.Idle(),
				maybePlatformError: clearPlatformError,
			});
			return withCommands(next, saveBarCommands(model, next));
		},
		ClickedBack: () => ({
			model,
			commands: [RequestNavigation({ href: "/dashboard" })],
		}),
		CompletedPlatform: () => ({ model }),
		FailedPlatform: ({ error }) => ({
			model: modifyFields(model, { maybePlatformError: () => Option.some(error) }),
		}),
		CompletedNavigation: () => ({ model }),
		StayedForNavigation: () => ({ model }),
	});
