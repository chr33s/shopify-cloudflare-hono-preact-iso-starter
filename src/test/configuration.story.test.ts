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
import { initialModel } from "#/features/configuration/model.ts";
import { update } from "#/features/configuration/update.ts";

const product = "gid://shopify/Product/1";
const other = "gid://shopify/Product/2";

function saved(title = "Spring", productIds: readonly string[] = [product]) {
	return initialModel({ title, productIds });
}

test("editing the name shows the save bar once", () => {
	story(
		update,
		given(saved()),
		message(Message.ChangedTitle({ value: "Summer" })),
		Command.expectExact(ShowSaveBar),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ChangedTitle({ value: "Summer edit" })),
		Command.expectNone(),
		model((next) => {
			expect(next.draft.title).toBe("Summer edit");
			expect(next.saved.title).toBe("Spring");
		}),
	);
});

test("restoring the saved name hides the save bar", () => {
	story(
		update,
		given(saved()),
		message(Message.ChangedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ChangedTitle({ value: "Spring" })),
		Command.expectExact(HideSaveBar),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.draft.title).toBe("Spring");
		}),
	);
});

test("save submits the captured draft and only then toasts", () => {
	const ids = [product];
	story(
		update,
		given(saved()),
		message(Message.ChangedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedSave()),
		Command.expectExact(SaveConfiguration({ title: "Summer", productIds: ids, revision: 1 })),
		Command.resolve(
			SaveConfiguration({ title: "Summer", productIds: ids, revision: 1 }),
			Message.SucceededSave({ title: "Summer", productIds: ids, revision: 1 }),
		),
		Command.expectExact(ShowToast({ message: "Configuration saved", isError: false }), HideSaveBar),
		Command.resolve(ShowToast({ message: "Configuration saved", isError: false }), Message.CompletedPlatform()),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.saved.title).toBe("Summer");
			expect(next.save._tag).toBe("Idle");
		}),
	);
});

test("an edit during save stays dirty when the older request succeeds", () => {
	const ids = [product];
	const opened = update(saved(), Message.ChangedTitle({ value: "Summer" }));
	const acknowledged = update(opened.model, Message.CompletedPlatform());
	const saving = update(acknowledged.model, Message.ClickedSave());
	expect(saving.commands?.[0]).toMatchObject({
		name: "SaveConfiguration",
		args: { title: "Summer", productIds: ids, revision: 1 },
	});

	const edited = update(saving.model, Message.ChangedTitle({ value: "Autumn" }));
	const savedResult = update(
		edited.model,
		Message.SucceededSave({ title: "Summer", productIds: ids, revision: 1 }),
	);

	expect(savedResult.commands?.map((command) => command.name)).toEqual(["ShowToast"]);
	expect(savedResult.model.saved.title).toBe("Summer");
	expect(savedResult.model.draft.title).toBe("Autumn");
	expect(savedResult.model.save._tag).toBe("Idle");
});

test("a stale save result does not replace a newer in-flight save", () => {
	const ids = [product];
	const opened = update(saved(), Message.ChangedTitle({ value: "Summer" }));
	const acknowledged = update(opened.model, Message.CompletedPlatform());
	const saving = update(acknowledged.model, Message.ClickedSave());
	const stale = update(
		saving.model,
		Message.SucceededSave({ title: "Old", productIds: ids, revision: 0 }),
	);

	expect(stale.model.saved.title).toBe("Spring");
	expect(stale.model.save._tag).toBe("Saving");
	expect(stale.commands ?? []).toEqual([]);
});

test("a failed save keeps the draft", () => {
	const ids = [product];
	story(
		update,
		given(saved()),
		message(Message.ChangedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedSave()),
		Command.resolve(
			SaveConfiguration({ title: "Summer", productIds: ids, revision: 1 }),
			Message.FailedSave({ error: "Network", revision: 1 }),
		),
		Command.resolve(ShowToast({ message: "Network", isError: true }), Message.CompletedPlatform()),
		model((next) => {
			expect(next.draft.title).toBe("Summer");
			expect(next.saved.title).toBe("Spring");
			expect(next.save).toEqual({ _tag: "Failed", error: "Network" });
		}),
	);
});

test("discard restores the saved configuration", () => {
	story(
		update,
		given(saved("Spring", [product])),
		message(Message.ChangedTitle({ value: "Summer" })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedDiscard()),
		Command.expectExact(HideSaveBar),
		Command.resolve(HideSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.draft).toEqual(next.saved);
			expect(next.draft.productIds).toEqual([product]);
		}),
	);
});

test("an invalid name does not save", () => {
	story(
		update,
		given(saved()),
		message(Message.ChangedTitle({ value: "   " })),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		message(Message.ClickedSave()),
		Command.expectNone(),
		model((next) => {
			expect(next.showValidation).toBe(true);
			expect(next.save._tag).toBe("Idle");
		}),
	);
});

test("the product picker ignores a second click and keeps ids on cancel", () => {
	const opening = update(saved(), Message.ClickedPickProducts());
	expect(opening.commands?.[0]).toMatchObject({
		name: "PickProducts",
		args: { selectedIds: [product] },
	});

	const ignored = update(opening.model, Message.ClickedPickProducts());
	expect(ignored.commands ?? []).toEqual([]);
	expect(ignored.model.picker._tag).toBe("Opening");

	const cancelled = update(ignored.model, Message.CancelledPickProducts());
	expect(cancelled.model.picker._tag).toBe("Closed");
	expect(cancelled.model.draft.productIds).toEqual([product]);
});

test("a confirmed picker replaces the selection and opens the save bar", () => {
	story(
		update,
		given(saved()),
		message(Message.ClickedPickProducts()),
		Command.resolve(
			PickProducts({ selectedIds: [product] }),
			Message.PickedProducts({ ids: [other] }),
		),
		Command.expectExact(ShowSaveBar),
		Command.resolve(ShowSaveBar, Message.CompletedPlatform()),
		model((next) => {
			expect(next.draft.productIds).toEqual([other]);
			expect(next.saved.productIds).toEqual([product]);
		}),
	);
});

test("back asks the host to navigate only after leave confirmation", () => {
	story(
		update,
		given(saved()),
		message(Message.ClickedBack()),
		Command.expectExact(RequestNavigation({ href: "/dashboard" })),
		Command.resolve(
			RequestNavigation({ href: "/dashboard" }),
			Message.CompletedNavigation(),
		),
		model((next) => {
			expect(next.draft.title).toBe("Spring");
		}),
	);
});
