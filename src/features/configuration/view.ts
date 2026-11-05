import type { Html, HtmlBuilder } from "foldkit/html";
import { Message } from "#/features/configuration/message.ts";
import { isDirty, titleError, type Model } from "#/features/configuration/model.ts";
import { SAVE_BAR_ID } from "#/features/configuration/save-bar.ts";
import { Banner, Button, Paragraph, SaveBar, Section, Stack, Text, TextField } from "#/ui/polaris.ts";

export function view(model: Model, h: HtmlBuilder<Message>): Html {
	const field = TextField.withMessage(h);
	const button = Button.withMessage(h);
	const banner = Banner.withMessage(h);
	const stack = Stack.withMessage(h);
	const text = Text.withMessage(h);
	const paragraph = Paragraph.withMessage(h);
	const section = Section.withMessage(h);
	const saveBar = SaveBar.withMessage(h);
	const picking = model.picker._tag === "Opening";
	const saving = model.save._tag === "Saving";
	const error = titleError(model.draft.title);
	const showError = error !== undefined && (model.showValidation || isDirty(model));

	const feedback: Html[] = [];
	if (model.picker._tag === "Failed") {
		feedback.push(
			banner([h.Attribute("tone", "critical")], [model.picker.error]),
		);
	}
	if (model.save._tag === "Failed") {
		feedback.push(banner([h.Attribute("tone", "critical")], [model.save.error]));
	}
	if (model.platformError) {
		feedback.push(banner([h.Attribute("tone", "critical")], [model.platformError]));
	}

	const products =
		model.draft.productIds.length === 0
			? [paragraph([], ["No products selected."])]
			: model.draft.productIds.map((id) => text([], [id]));

	return stack(
		[stack.Gap("base")],
		[
			saveBar(
				[h.Id(SAVE_BAR_ID)],
				[
					h.button(
						[h.Attribute("variant", "primary"), h.OnClick(Message.ClickedSave())],
						["Save"],
					),
					h.button([h.OnClick(Message.ClickedDiscard())], ["Discard"]),
				],
			),
			section(
				[section.Heading("Configuration")],
				[
					field([
						field.Label("Configuration name"),
						field.Value(model.draft.title),
						field.Disabled(picking),
						field.Error(showError && error ? error : ""),
						field.Details("Shown to merchants wherever this configuration is used."),
						h.OnInput((value) => Message.ChangedTitle({ value })),
					]),
				],
			),
			section(
				[section.Heading("Products")],
				[
					...products,
					button(
						[
							button.Disabled(picking || saving),
							button.Loading(picking),
							h.Attribute("variant", "secondary"),
							h.OnClick(Message.ClickedPickProducts()),
						],
						[picking ? "Selecting products" : "Select products"],
					),
				],
			),
			...feedback,
			button(
				[button.Disabled(saving), h.OnClick(Message.ClickedBack())],
				["Back to dashboard"],
			),
		],
	);
}
