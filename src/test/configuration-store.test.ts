import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import type { ConfigurationKv } from "#/configuration/record.ts";
import { ConfigurationRejected, makeConfigurationStore } from "#/server/configuration-store.ts";

const product = "gid://shopify/Product/10";

function memoryKv(): ConfigurationKv {
	const stored = new Map<string, unknown>();
	return {
		get: async (key) => stored.get(key) ?? null,
		put: async (key, value) => {
			stored.set(key, JSON.parse(value));
		},
		delete: async (key) => {
			stored.delete(key);
		},
	};
}

async function run<A, E>(effect: Effect.Effect<A, E>) {
	return Effect.runPromise(Effect.result(effect));
}

test("save writes the next revision and read returns it", async () => {
	const store = makeConfigurationStore(memoryKv());
	const shop = "demo.myshopify.com";

	const saved = await run(
		store.save(shop, {
			title: "  Summer ",
			products: [{ id: product, title: " Tee " }],
			expectedRevision: 0,
		}),
	);
	expect(Result.isSuccess(saved) && saved.success).toEqual({
		title: "Summer",
		products: [{ id: product, title: "Tee" }],
		revision: 1,
	});

	const loaded = await run(store.read(shop));
	expect(Result.isSuccess(loaded) && loaded.success.revision).toBe(1);
});

test("rejects a stale revision without writing", async () => {
	const store = makeConfigurationStore(memoryKv());
	const shop = "demo.myshopify.com";
	const body = {
		title: "Summer",
		products: [{ id: product, title: "Tee" }],
		expectedRevision: 0,
	};
	await Effect.runPromise(store.save(shop, body));

	const result = await run(store.save(shop, { ...body, title: "Autumn" }));
	expect(Result.isFailure(result)).toBe(true);
	if (Result.isFailure(result)) {
		expect(result.failure).toBeInstanceOf(ConfigurationRejected);
		expect(result.failure).toMatchObject({
			status: 409,
			message: "This configuration was updated somewhere else. Reload and try again.",
		});
	}

	const loaded = await run(store.read(shop));
	expect(Result.isSuccess(loaded) && loaded.success.title).toBe("Summer");
});

test("rejects an invalid body with the parser message", async () => {
	const store = makeConfigurationStore(memoryKv());
	const result = await run(store.save("demo.myshopify.com", { title: "  ", products: [] }));
	expect(Result.isFailure(result)).toBe(true);
	if (Result.isFailure(result)) {
		expect(result.failure).toMatchObject({
			_tag: "ConfigurationRejected",
			status: 400,
			message: "Enter a configuration name.",
		});
	}
});
