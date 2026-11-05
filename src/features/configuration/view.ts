import { Array, Option } from "effect";
import { match as matchField } from "foldkit/fieldValidation";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Message } from "#/features/configuration/message.ts";
import { type Model, type Product } from "#/features/configuration/model.ts";
import { SAVE_BAR_ID } from "#/features/configuration/save-bar.ts";
import {
	Banner,
	Button,
	Paragraph,
	SaveBar,
	Section,
	Stack,
	Text,
	TextField,
} from "#/ui/polaris.ts";

const NAME_LABEL = "Configuration name";

function fieldError(model: Model) {
	return matchField(model.draftTitle, {
		onNotValidated: () => "",
		onValidating: () => "",
		onValid: () => "",
		onInvalid: ({ errors }) => Option.getOrElse(Array.head(errors), () => ""),
	});
}

function saveBarView(model: Model, h: HtmlBuilder<Message>): Html {
	const saveBar = SaveBar.withMessage(h);
	const saving = model.save._tag === "Saving";
	// NOTE: hand-rolling because Shopify ui-save-bar only accepts native button children, not s-button or @foldkit/ui Button.
	return saveBar(
		[h.Id(SAVE_BAR_ID)],
		[
			h.button(
				[
					h.Attribute("variant", "primary"),
					h.Disabled(saving),
					h.AriaBusy(saving),
					h.OnClick(Message.ClickedSave()),
				],
				["Save"],
			),
			h.button([h.OnClick(Message.ClickedDiscard())], ["Discard"]),
		],
	);
}

function titleSection(model: Model, h: HtmlBuilder<Message>): Html {
	const field = TextField.withMessage(h);
	const section = Section.withMessage(h);
	const picking = model.picker._tag === "Opening";
	return section(
		[section.Heading("Configuration")],
		[
			field([
				field.Label(NAME_LABEL),
				h.AriaLabel(NAME_LABEL),
				field.Value(model.draftTitle.value),
				field.Disabled(picking),
				field.Error(fieldError(model)),
				field.Details("Shown to merchants wherever this configuration is used."),
				h.OnInput((value) => Message.UpdatedTitle({ value })),
			]),
		],
	);
}

function productRow(product: Product, h: HtmlBuilder<Message>): Html {
	const text = Text.withMessage(h);
	return h.keyed("li")(product.id, [], [text([], [product.title])]);
}

function productsSection(model: Model, h: HtmlBuilder<Message>): Html {
	const button = Button.withMessage(h);
	const paragraph = Paragraph.withMessage(h);
	const section = Section.withMessage(h);
	const picking = model.picker._tag === "Opening";
	const saving = model.save._tag === "Saving";
	const rows = Array.match(model.draftProducts, {
		onEmpty: () => [paragraph([], ["No products selected."])],
		onNonEmpty: (products) => [
			h.ul(
				[],
				Array.map(products, (product) => productRow(product, h)),
			),
		],
	});
	return section(
		[section.Heading("Products")],
		[
			...rows,
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
	);
}

function feedback(model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> {
	const banner = Banner.withMessage(h);
	const critical = (message: string) => banner([h.Attribute("tone", "critical")], [message]);
	const pickerError = model.picker._tag === "Failed" ? [critical(model.picker.error)] : [];
	const saveError = model.save._tag === "Failed" ? [critical(model.save.error)] : [];
	const platformError = Option.match(model.maybePlatformError, {
		onNone: () => [],
		onSome: (error) => [critical(error)],
	});
	return [...pickerError, ...saveError, ...platformError];
}

export function view(model: Model, h: HtmlBuilder<Message>): Html {
	const button = Button.withMessage(h);
	const stack = Stack.withMessage(h);
	const saving = model.save._tag === "Saving";
	return stack(
		[stack.Gap("base")],
		[
			saveBarView(model, h),
			titleSection(model, h),
			productsSection(model, h),
			...feedback(model, h),
			button([button.Disabled(saving), h.OnClick(Message.ClickedBack())], ["Back to dashboard"]),
		],
	);
}
