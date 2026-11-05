import { Effect, Option, Schema } from "effect";
import { Product } from "#/features/configuration/model.ts";

export const ConfigurationBody = Schema.Struct({
	title: Schema.String,
	products: Schema.Array(Product),
	revision: Schema.Number,
});
export type ConfigurationBody = typeof ConfigurationBody.Type;

const ConfigurationWrite = Schema.Struct({
	title: Schema.String,
	products: Schema.Array(Product),
	expectedRevision: Schema.Number,
});
type ConfigurationWrite = typeof ConfigurationWrite.Type;

const ErrorBody = Schema.Struct({
	error: Schema.optional(Schema.String),
});

function message(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

const decodeBody = Schema.decodeUnknownEffect(ConfigurationBody);

// A non-JSON or unexpected error body still fails with the status. The message
// is kept only when the payload is `{ error: string }`.
function readJson(response: Response) {
	return Effect.gen(function* () {
		if (!response.ok) {
			const body = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined));
			const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
			const detail =
				Option.isSome(decoded) && decoded.value.error !== undefined
					? ` ${decoded.value.error}`
					: "";
			return yield* Effect.fail(`Request failed (${response.status}).${detail}`);
		}

		return yield* Effect.tryPromise({
			try: () => response.json(),
			catch: message,
		});
	});
}

export const loadConfiguration = Effect.fn("ConfigurationApi.load")(function* (): Effect.fn.Return<
	ConfigurationBody,
	string
> {
	const response = yield* Effect.tryPromise({
		try: (signal) =>
			fetch("/api/configuration", {
				headers: { Accept: "application/json" },
				signal,
			}),
		catch: message,
	});
	const body = yield* readJson(response);
	return yield* decodeBody(body).pipe(
		Effect.mapError(() => "The server returned an unexpected configuration."),
	);
});

export const saveConfiguration = Effect.fn("ConfigurationApi.save")(function* (
	body: ConfigurationWrite,
): Effect.fn.Return<ConfigurationBody, string> {
	const response = yield* Effect.tryPromise({
		try: (signal) =>
			fetch("/api/configuration", {
				method: "PUT",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			}),
		catch: message,
	});
	const payload = yield* readJson(response);
	return yield* decodeBody(payload).pipe(
		Effect.mapError(() => "The server returned an unexpected configuration."),
	);
});
