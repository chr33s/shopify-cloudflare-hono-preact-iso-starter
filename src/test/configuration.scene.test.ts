import { Option } from "effect";
import { test } from "vitest";
import { Command, click, expect, given, label, scene, text, type } from "foldkit/scene";
import {
	PickProducts,
	SaveConfiguration,
	ShowSaveBar,
	ShowToast,
	HideSaveBar,
} from "#/features/configuration/commands.ts";
import { Message } from "#/features/configuration/message.ts";
import { initialModel, type Product } from "#/features/configuration/model.ts";
import { update } from "#/features/configuration/update.ts";
import { view } from "#/features/configuration/view.ts";

const product: Product = { id: "gid://shopify/Product/1", title: "Tee" };
const other: Product = { id: "gid://shopify/Product/2", title: "Hat" };

const summerSave = SaveConfiguration({
	title: "Summer",
	products: [product],
	revision: 1,
	expectedRevision: 3,
});

test("editing the name and saving updates the stored title", () => {
	scene(
		{ update, view },
		given(initialModel({ title: "Spring", products: [product], revision: 3 })),
		expect(text("Tee")).toExist(),
		type(label("Configuration name"), "Summer"),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		click(text("Save")),
		Command.expectExact(summerSave),
		Command.resolve(
			summerSave,
			Message.SucceededSaveConfiguration({
				title: "Summer",
				products: [product],
				revision: 1,
				savedRevision: 4,
			}),
		),
		Command.resolve(
			ShowToast({ message: "Configuration saved", isError: false }),
			Message.CompletedPlatform(),
		),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		expect(text("Tee")).toExist(),
	);
});

test("a failed product picker shows the error and keeps the current product", () => {
	scene(
		{ update, view },
		given(initialModel({ title: "Spring", products: [product], revision: 3 })),
		click(text("Select products")),
		Command.resolve(
			PickProducts({ selectedIds: [product.id] }),
			Message.FailedPickProducts({ error: "Picker failed" }),
		),
		expect(text("Picker failed")).toExist(),
		expect(text("Tee")).toExist(),
		expect(text("Hat")).toBeAbsent(),
	);
});

test("a confirmed picker shows the selected product title", () => {
	scene(
		{ update, view },
		given(initialModel({ title: "Spring", products: [product], revision: 3 })),
		click(text("Select products")),
		Command.resolve(
			PickProducts({ selectedIds: [product.id] }),
			Message.SucceededPickProducts({ products: Option.some([other]) }),
		),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		expect(text("Hat")).toExist(),
		expect(text("Tee")).toBeAbsent(),
	);
});
