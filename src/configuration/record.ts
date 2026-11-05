// Shop-scoped product configuration stored beside sessions in SESSION_KV.
// The key prefix keeps it out of the admin session slot. Deleted on uninstall.

export const CONFIGURATION_KEY_PREFIX = "configuration:";
export const MAX_TITLE_LENGTH = 120;
export const MAX_PRODUCTS = 50;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export interface ConfigurationRecord {
	title: string;
	productIds: string[];
}

export interface ConfigurationKv {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export function emptyConfiguration(): ConfigurationRecord {
	return { title: "", productIds: [] };
}

export function configurationKey(shop: string) {
	return `${CONFIGURATION_KEY_PREFIX}${shop}`;
}

export type ParseResult =
	| { ok: true; record: ConfigurationRecord }
	| { ok: false; error: string };

export function parseConfigurationBody(input: unknown): ParseResult {
	if (typeof input !== "object" || input === null) {
		return { ok: false, error: "Configuration body must be an object." };
	}

	const body = input as Record<string, unknown>;
	const title = body.title;
	const productIds = body.productIds;

	if (typeof title !== "string" || title.trim().length === 0) {
		return { ok: false, error: "Enter a configuration name." };
	}
	if (title.length > MAX_TITLE_LENGTH) {
		return { ok: false, error: `Use ${MAX_TITLE_LENGTH} characters or fewer.` };
	}
	if (!Array.isArray(productIds)) {
		return { ok: false, error: "Product ids must be a list." };
	}
	if (productIds.length > MAX_PRODUCTS) {
		return { ok: false, error: `Select ${MAX_PRODUCTS} products or fewer.` };
	}

	const ids: string[] = [];
	for (const id of productIds) {
		if (typeof id !== "string" || !PRODUCT_GID.test(id)) {
			return { ok: false, error: "Product ids must be Shopify product GIDs." };
		}
		ids.push(id);
	}

	return { ok: true, record: { title, productIds: ids } };
}

export function parseStoredConfiguration(input: unknown): ParseResult {
	return parseConfigurationBody(input);
}

export async function readConfiguration(kv: ConfigurationKv, shop: string): Promise<ConfigurationRecord> {
	const stored = await kv.get(configurationKey(shop), "json");
	if (stored === null || stored === undefined) return emptyConfiguration();

	const parsed = parseStoredConfiguration(stored);
	if (!parsed.ok) {
		throw new Error("Stored configuration is unreadable");
	}
	return parsed.record;
}

export async function writeConfiguration(
	kv: ConfigurationKv,
	shop: string,
	record: ConfigurationRecord,
): Promise<void> {
	await kv.put(configurationKey(shop), JSON.stringify(record));
}

export async function deleteConfiguration(kv: ConfigurationKv, shop: string): Promise<void> {
	await kv.delete(configurationKey(shop));
}
