import { Option } from "effect";
import { expect, test } from "vitest";
import { Command, given, message, model, story } from "foldkit/story";
import {
	HideSaveBar,
	PickProducts,
	RequestNavigation,
	SaveConfiguration,
	ShowSaveBar,
	ShowToast,
} from "#/features/configuration/commands.ts";
import { Message } from "#/features/configuration/message.ts";
import { initialModel, type Product } from "#/features/configuration/model.ts";
import { update } from "#/features/configuration/update.ts";

const product: Product = { id: "gid://shopify/Product/1", title: "Tee" };
const other: Product = { id: "gid://shopify/Product/2", title: "Hat" };

function saved(title = "Spring", products: ReadonlyArray<Product> = [product], revision = 3) {
	return initialModel({ title, products, revision });
}

const summerSave = SaveConfiguration({
	title: "Summer",
	products: [product],
	revision: 1,
	expectedRevision: 3,
});

test("editing the name shows the save bar once", () => {
	story(
		update,
		given(saved()),
		message(Message.UpdatedTitle({ value: "Summer" })),
		Command.expectExact(ShowSaveBar),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.UpdatedTitle({ value: "Summer edit" })),
		Command.expectNone(),
		model((next) => {
			expect(next.draftTitle.value).toBe("Summer edit");
			expect(next.saved.title).toBe("Spring");
		}),
	);
});

test("restoring the saved name hides the save bar", () => {
	story(
		update,
		given(saved()),
		message(Message.UpdatedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.UpdatedTitle({ value: "Spring" })),
		Command.expectExact(HideSaveBar),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.draftTitle.value).toBe("Spring");
		}),
	);
});

test("save submits the captured draft and only then toasts", () => {
	story(
		update,
		given(saved()),
		message(Message.UpdatedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedSave()),
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
		Command.expectExact(ShowToast({ message: "Configuration saved", isError: false }), HideSaveBar),
		Command.resolve(
			ShowToast({ message: "Configuration saved", isError: false }),
			Message.CompletedPlatform(),
		),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.saved.title).toBe("Summer");
			expect(next.savedRevision).toBe(4);
			expect(next.save._tag).toBe("Idle");
		}),
	);
});

test("an edit during save stays dirty and keeps the save bar available", () => {
	const opened = update(saved(), Message.UpdatedTitle({ value: "Summer" }));
	const acknowledged = update(opened.model, Message.CompletedPlatform());
	const saving = update(acknowledged.model, Message.ClickedSave());
	expect(saving.commands?.[0]).toMatchObject({
		name: "SaveConfiguration",
		args: { title: "Summer", products: [product], revision: 1, expectedRevision: 3 },
	});

	const edited = update(saving.model, Message.UpdatedTitle({ value: "Autumn" }));
	expect(edited.commands ?? []).toEqual([]);

	const savedResult = update(
		edited.model,
		Message.SucceededSaveConfiguration({
			title: "Summer",
			products: [product],
			revision: 1,
			savedRevision: 4,
		}),
	);

	expect(savedResult.commands?.map((command) => command.name)).toEqual([
		"ShowToast",
		"ShowSaveBar",
	]);
	expect(savedResult.model.saved.title).toBe("Summer");
	expect(savedResult.model.draftTitle.value).toBe("Autumn");
	expect(savedResult.model.save._tag).toBe("Idle");
});

test("reverting the draft while a different snapshot is saving does not hide the bar", () => {
	const opened = update(saved(), Message.UpdatedTitle({ value: "Summer" }));
	const acknowledged = update(opened.model, Message.CompletedPlatform());
	const saving = update(acknowledged.model, Message.ClickedSave());
	const reverted = update(saving.model, Message.UpdatedTitle({ value: "Spring" }));

	expect(reverted.model.save._tag).toBe("Saving");
	expect(reverted.commands ?? []).toEqual([]);

	const savedResult = update(
		reverted.model,
		Message.SucceededSaveConfiguration({
			title: "Summer",
			products: [product],
			revision: 1,
			savedRevision: 4,
		}),
	);

	expect(savedResult.commands?.map((command) => command.name)).toEqual([
		"ShowToast",
		"ShowSaveBar",
	]);
	expect(savedResult.model.saved.title).toBe("Summer");
	expect(savedResult.model.draftTitle.value).toBe("Spring");
});

test("a stale save result does not replace a newer in-flight save", () => {
	const opened = update(saved(), Message.UpdatedTitle({ value: "Summer" }));
	const acknowledged = update(opened.model, Message.CompletedPlatform());
	const saving = update(acknowledged.model, Message.ClickedSave());
	const stale = update(
		saving.model,
		Message.SucceededSaveConfiguration({
			title: "Old",
			products: [product],
			revision: 0,
			savedRevision: 1,
		}),
	);

	expect(stale.model.saved.title).toBe("Spring");
	expect(stale.model.save._tag).toBe("Saving");
	expect(stale.commands ?? []).toEqual([]);
});

test("a failed save keeps the draft", () => {
	story(
		update,
		given(saved()),
		message(Message.UpdatedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedSave()),
		Command.resolve(summerSave, Message.FailedSaveConfiguration({ error: "Network", revision: 1 })),
		Command.resolve(ShowToast({ message: "Network", isError: true }), Message.CompletedPlatform()),
		model((next) => {
			expect(next.draftTitle.value).toBe("Summer");
			expect(next.saved.title).toBe("Spring");
			expect(next.save).toEqual({ _tag: "Failed", error: "Network" });
		}),
	);
});

test("discard restores the saved configuration", () => {
	story(
		update,
		given(saved("Spring", [product])),
		message(Message.UpdatedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedDiscard()),
		Command.expectExact(HideSaveBar),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.draftTitle.value).toBe(next.saved.title);
			expect(next.draftProducts).toEqual([product]);
		}),
	);
});

test("discard is ignored while a save or the picker is in flight", () => {
	const opened = update(saved(), Message.UpdatedTitle({ value: "Summer" }));
	const acknowledged = update(opened.model, Message.CompletedPlatform());
	const saving = update(acknowledged.model, Message.ClickedSave());
	const discardedDuringSave = update(saving.model, Message.ClickedDiscard());

	expect(discardedDuringSave.model.save._tag).toBe("Saving");
	expect(discardedDuringSave.model.draftTitle.value).toBe("Summer");
	expect(discardedDuringSave.commands ?? []).toEqual([]);

	const picking = update(saved(), Message.ClickedPickProducts());
	const discardedDuringPick = update(picking.model, Message.ClickedDiscard());
	expect(discardedDuringPick.model.picker._tag).toBe("Opening");
	expect(discardedDuringPick.commands ?? []).toEqual([]);
});

test("an invalid name does not save", () => {
	story(
		update,
		given(saved()),
		message(Message.UpdatedTitle({ value: "   " })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedSave()),
		Command.expectNone(),
		model((next) => {
			expect(next.draftTitle._tag).toBe("Invalid");
			expect(next.save._tag).toBe("Idle");
		}),
	);
});

test("the product picker ignores a second click and keeps products on cancel", () => {
	const opening = update(saved(), Message.ClickedPickProducts());
	expect(opening.commands?.[0]).toMatchObject({
		name: "PickProducts",
		args: { selectedIds: [product.id] },
	});

	const ignored = update(opening.model, Message.ClickedPickProducts());
	expect(ignored.commands ?? []).toEqual([]);
	expect(ignored.model.picker._tag).toBe("Opening");

	const cancelled = update(
		ignored.model,
		Message.SucceededPickProducts({ products: Option.none() }),
	);
	expect(cancelled.model.picker._tag).toBe("Closed");
	expect(cancelled.model.draftProducts).toEqual([product]);
});

test("a confirmed picker replaces the selection and opens the save bar", () => {
	story(
		update,
		given(saved()),
		message(Message.ClickedPickProducts()),
		Command.resolve(
			PickProducts({ selectedIds: [product.id] }),
			Message.SucceededPickProducts({ products: Option.some([other]) }),
		),
		Command.expectExact(ShowSaveBar),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.draftProducts).toEqual([other]);
			expect(next.saved.products).toEqual([product]);
		}),
	);
});

test("a picker failure keeps the current products", () => {
	const opening = update(saved(), Message.ClickedPickProducts());
	const failed = update(opening.model, Message.FailedPickProducts({ error: "Picker failed" }));

	expect(failed.model.picker).toEqual({ _tag: "Failed", error: "Picker failed" });
	expect(failed.model.draftProducts).toEqual([product]);
	expect(failed.commands ?? []).toEqual([]);
});

test("too many picked products are rejected", () => {
	const products = Array.from({ length: 51 }, (_, index) => ({
		id: `gid://shopify/Product/${index + 1}`,
		title: `Product ${index + 1}`,
	}));
	const opening = update(saved(), Message.ClickedPickProducts());
	const failed = update(
		opening.model,
		Message.SucceededPickProducts({ products: Option.some(products) }),
	);

	expect(failed.model.picker._tag).toBe("Failed");
	expect(failed.model.draftProducts).toEqual([product]);
});

test("a platform failure is visible and a later edit clears it", () => {
	const failed = update(saved(), Message.FailedPlatform({ error: "App Bridge is not available" }));
	expect(failed.model.maybePlatformError._tag).toBe("Some");

	const edited = update(failed.model, Message.UpdatedTitle({ value: "Summer" }));
	expect(edited.model.maybePlatformError._tag).toBe("None");
});

test("show and hide failures surface as platform errors", () => {
	const shown = update(saved(), Message.UpdatedTitle({ value: "Summer" }));
	const failedShow = update(
		shown.model,
		Message.FailedPlatform({ error: "Could not show the save bar" }),
	);
	expect(failedShow.model.maybePlatformError._tag).toBe("Some");

	const stayed = update(failedShow.model, Message.StayedForNavigation());
	expect(stayed.model.draftTitle.value).toBe("Summer");
});

test("back asks the host to navigate only after leave confirmation", () => {
	story(
		update,
		given(saved()),
		message(Message.ClickedBack()),
		Command.expectExact(RequestNavigation({ href: "/dashboard" })),
		Command.resolve(RequestNavigation({ href: "/dashboard" }), Message.CompletedNavigation()),
		model((next) => {
			expect(next.draftTitle.value).toBe("Spring");
		}),
	);
});
