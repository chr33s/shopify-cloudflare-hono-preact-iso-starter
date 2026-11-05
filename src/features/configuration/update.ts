import { Update } from "foldkit";
import {
	HideSaveBar,
	PickProducts,
	RequestNavigation,
	SaveConfiguration,
	ShowSaveBar,
	ShowToast,
} from "#/features/configuration/commands.ts";
import { Message } from "#/features/configuration/message.ts";
import { isDirty, Picker, Save, titleError, type Model } from "#/features/configuration/model.ts";
import type { AdminUi } from "#/platform/admin-ui.ts";

type UpdateReturn = Update.Return<Model, Message, AdminUi>;
type Commands = Update.Commands<Message, AdminUi>;

function reconcileSaveBar(before: Model, after: Model): Commands {
	const wasDirty = isDirty(before);
	const nowDirty = isDirty(after);
	if (!wasDirty && nowDirty) return [ShowSaveBar()];
	if (wasDirty && !nowDirty) return [HideSaveBar()];
	return [];
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ChangedTitle: ({ value }) => {
			const next = {
				...model,
				draft: { ...model.draft, title: value },
				platformError: "",
			};
			return { model: next, commands: reconcileSaveBar(model, next) };
		},
		ClickedPickProducts: () => {
			if (model.picker._tag === "Opening") return { model };
			return {
				model: { ...model, picker: Picker.Opening(), platformError: "" },
				commands: [PickProducts({ selectedIds: model.draft.productIds })],
			};
		},
		PickedProducts: ({ ids }) => {
			if (model.picker._tag !== "Opening") return { model };
			const next = {
				...model,
				draft: { ...model.draft, productIds: [...ids] },
				picker: Picker.Closed(),
			};
			return { model: next, commands: reconcileSaveBar(model, next) };
		},
		CancelledPickProducts: () => {
			if (model.picker._tag !== "Opening") return { model };
			return { model: { ...model, picker: Picker.Closed() } };
		},
		FailedPickProducts: ({ error }) => {
			if (model.picker._tag !== "Opening") return { model };
			return { model: { ...model, picker: Picker.Failed({ error }) } };
		},
		ClickedSave: () => {
			if (model.save._tag === "Saving" || model.picker._tag === "Opening") return { model };
			if (titleError(model.draft.title)) {
				return { model: { ...model, showValidation: true } };
			}
			if (!isDirty(model)) return { model };

			const revision = model.revision + 1;
			return {
				model: {
					...model,
					revision,
					save: Save.Saving({ revision }),
					showValidation: false,
					platformError: "",
				},
				commands: [
					SaveConfiguration({
						title: model.draft.title,
						productIds: model.draft.productIds,
						revision,
					}),
				],
			};
		},
		SucceededSave: ({ title, productIds, revision }) => {
			// Only the snapshot that was sent becomes the saved baseline.
			// Edits made while the request was in flight stay on the draft.
			if (model.save._tag !== "Saving" || model.save.revision !== revision) return { model };
			const next = {
				...model,
				saved: { title, productIds: [...productIds] },
				save: Save.Idle(),
			};
			const toast = ShowToast({ message: "Configuration saved", isError: false });
			const commands: Commands = isDirty(next) ? [toast] : [toast, HideSaveBar()];
			return { model: next, commands };
		},
		FailedSave: ({ error, revision }) => {
			if (model.save._tag !== "Saving" || model.save.revision !== revision) return { model };
			return {
				model: { ...model, save: Save.Failed({ error }) },
				commands: [ShowToast({ message: error, isError: true })],
			};
		},
		ClickedDiscard: () => ({
			model: {
				...model,
				draft: {
					title: model.saved.title,
					productIds: [...model.saved.productIds],
				},
				picker: Picker.Closed(),
				save: Save.Idle(),
				showValidation: false,
				platformError: "",
			},
			commands: isDirty(model) ? [HideSaveBar()] : [],
		}),
		ClickedBack: () => ({
			model,
			commands: [RequestNavigation({ href: "/dashboard" })],
		}),
		CompletedPlatform: () => ({ model }),
		FailedPlatform: ({ error }) => ({ model: { ...model, platformError: error } }),
		CompletedNavigation: () => ({ model }),
		StayedForNavigation: () => ({ model }),
	});
