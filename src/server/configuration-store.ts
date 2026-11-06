import { Context, Effect, Schema } from "effect";
import { ConfigurationRecord } from "#/configuration/contract.ts";
import {
	parseConfigurationWrite,
	readConfiguration,
	writeConfiguration,
	type ConfigurationKv,
} from "#/configuration/record.ts";

export class ConfigurationRejected extends Schema.TaggedError<ConfigurationRejected>()(
	"ConfigurationRejected",
	{
		status: Schema.Literals([400, 409]),
		message: Schema.String,
	},
) {}

export class ConfigurationUnavailable extends Schema.TaggedError<ConfigurationUnavailable>()(
	"ConfigurationUnavailable",
	{
		operation: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export type ConfigurationStoreError = ConfigurationRejected | ConfigurationUnavailable;

export class ConfigurationStore extends Context.Service<
	ConfigurationStore,
	{
		readonly read: (shop: string) => Effect.Effect<ConfigurationRecord, ConfigurationUnavailable>;
		readonly save: (
			shop: string,
			input: unknown,
		) => Effect.Effect<ConfigurationRecord, ConfigurationStoreError>;
	}
>()("ConfigurationStore") {}

export function makeConfigurationStore(kv: ConfigurationKv) {
	const read = Effect.fn("ConfigurationStore.read")(function* (
		shop: string,
	): Effect.fn.Return<ConfigurationRecord, ConfigurationUnavailable> {
		return yield* Effect.tryPromise({
			try: () => readConfiguration(kv, shop),
			catch: (cause) =>
				new ConfigurationUnavailable({ operation: "ConfigurationStore.read", cause }),
		});
	});

	const save = Effect.fn("ConfigurationStore.save")(function* (
		shop: string,
		input: unknown,
	): Effect.fn.Return<ConfigurationRecord, ConfigurationStoreError> {
		const parsed = parseConfigurationWrite(input);
		if (!parsed.ok) {
			return yield* new ConfigurationRejected({ status: 400, message: parsed.error });
		}

		const current = yield* read(shop);
		if (current.revision !== parsed.value.expectedRevision) {
			return yield* new ConfigurationRejected({
				status: 409,
				message: "This configuration was updated somewhere else. Reload and try again.",
			});
		}

		const next = {
			title: parsed.value.title,
			products: parsed.value.products,
			revision: current.revision + 1,
		};
		yield* Effect.tryPromise({
			try: () => writeConfiguration(kv, shop, next),
			catch: (cause) =>
				new ConfigurationUnavailable({ operation: "ConfigurationStore.save", cause }),
		});
		return next;
	});

	return ConfigurationStore.of({ read, save });
}
