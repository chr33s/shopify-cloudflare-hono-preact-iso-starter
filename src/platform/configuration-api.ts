import { Effect, Schema } from "effect";

export const ConfigurationBody = Schema.Struct({
	title: Schema.String,
	productIds: Schema.Array(Schema.String),
});
export type ConfigurationBody = typeof ConfigurationBody.Type;

async function readJson(response: Response): Promise<unknown> {
	if (!response.ok) {
		let detail = "";
		try {
			const body = (await response.json()) as { error?: unknown };
			if (typeof body.error === "string") detail = ` ${body.error}`;
		} catch {
			// Non-JSON error bodies still surface via the status code.
		}
		throw new Error(`Request failed (${response.status}).${detail}`);
	}
	return response.json();
}

function decodeBody(input: unknown) {
	return Schema.decodeUnknownEffect(ConfigurationBody)(input).pipe(
		Effect.mapError(() => "The server returned an unexpected configuration."),
	);
}

export const loadConfiguration = Effect.tryPromise({
	try: async () => {
		const response = await fetch("/api/configuration", {
			headers: { Accept: "application/json" },
		});
		return readJson(response);
	},
	catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
}).pipe(Effect.flatMap(decodeBody));

export const saveConfiguration = (body: ConfigurationBody) =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch("/api/configuration", {
				method: "PUT",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			return readJson(response);
		},
		catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
	}).pipe(Effect.flatMap(decodeBody));
