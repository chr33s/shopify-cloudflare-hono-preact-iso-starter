// Shop-scoped product configuration stored beside sessions in SESSION_KV.
// The key prefix keeps it out of the admin session slot. Deleted on uninstall.

export const CONFIGURATION_KEY_PREFIX = "configuration:";
export const MAX_TITLE_LENGTH = 120;
export const MAX_PRODUCTS = 50;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export interface ProductRecord {
	id: string;
	title: string;
}

export interface ConfigurationRecord {
	title: string;
	products: ProductRecord[];
	revision: number;
}

export interface ConfigurationWrite {
	title: string;
	products: ProductRecord[];
	expectedRevision: number;
}

export interface ConfigurationKv {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export function emptyConfiguration(): ConfigurationRecord {
	return { title: "", products: [], revision: 0 };
}

export function configurationKey(shop: string) {
	return `${CONFIGURATION_KEY_PREFIX}${shop}`;
}

export function isProductGid(id: string) {
	return PRODUCT_GID.test(id);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ParseResult<T> {
	return { ok: false, error };
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseRevision(input: unknown): number | undefined {
	if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
		return undefined;
	}
	return input;
}

function parseProduct(input: unknown): ProductRecord | undefined {
	if (typeof input === "string") {
		return isProductGid(input) ? { id: input, title: input } : undefined;
	}
	if (!isRecord(input) || typeof input.id !== "string" || !isProductGid(input.id)) {
		return undefined;
	}
	const title = typeof input.title === "string" ? input.title.trim() : "";
	return { id: input.id, title: title.length > 0 ? title : input.id };
}

function dedupeProducts(products: ReadonlyArray<ProductRecord>): ProductRecord[] {
	return products.reduce<ProductRecord[]>((unique, product) => {
		if (unique.some((existing) => existing.id === product.id)) {
			return unique;
		}
		return [...unique, product];
	}, []);
}

function parseProductList(input: unknown): ParseResult<ProductRecord[]> {
	if (!Array.isArray(input)) {
		return fail("Products must be a list.");
	}

	const parsed = input.reduce<ParseResult<ProductRecord[]>>(
		(result, item) => {
			if (!result.ok) {
				return result;
			}
			const product = parseProduct(item);
			if (product === undefined) {
				return fail("Product ids must be Shopify product GIDs.");
			}
			return { ok: true, value: [...result.value, product] };
		},
		{ ok: true, value: [] },
	);
	if (!parsed.ok) {
		return parsed;
	}

	const products = dedupeProducts(parsed.value);
	if (products.length > MAX_PRODUCTS) {
		return fail(`Select ${MAX_PRODUCTS} products or fewer.`);
	}
	return { ok: true, value: products };
}

function parseTitle(input: unknown): ParseResult<string> {
	if (typeof input !== "string") {
		return fail("Enter a configuration name.");
	}
	const title = input.trim();
	if (title.length === 0) {
		return fail("Enter a configuration name.");
	}
	if (title.length > MAX_TITLE_LENGTH) {
		return fail(`Use ${MAX_TITLE_LENGTH} characters or fewer.`);
	}
	return { ok: true, value: title };
}

export function parseConfigurationWrite(input: unknown): ParseResult<ConfigurationWrite> {
	if (!isRecord(input)) {
		return fail("Configuration body must be an object.");
	}

	const title = parseTitle(input.title);
	if (!title.ok) {
		return title;
	}

	const products = parseProductList(input.products);
	if (!products.ok) {
		return products;
	}

	const expectedRevision = parseRevision(input.expectedRevision);
	if (expectedRevision === undefined) {
		return fail("Revision must be a whole number.");
	}

	return {
		ok: true,
		value: { title: title.value, products: products.value, expectedRevision },
	};
}

export function parseStoredConfiguration(input: unknown): ParseResult<ConfigurationRecord> {
	if (!isRecord(input)) {
		return fail("Stored configuration is unreadable.");
	}

	const title = parseTitle(input.title);
	if (!title.ok) {
		return title;
	}

	const products = parseProductList(
		input.products !== undefined ? input.products : input.productIds,
	);
	if (!products.ok) {
		return products;
	}

	const revision = input.revision === undefined ? 0 : parseRevision(input.revision);
	if (revision === undefined) {
		return fail("Stored configuration is unreadable.");
	}

	return {
		ok: true,
		value: { title: title.value, products: products.value, revision },
	};
}

export async function readConfiguration(
	kv: ConfigurationKv,
	shop: string,
): Promise<ConfigurationRecord> {
	const stored = await kv.get(configurationKey(shop), "json");
	if (stored === null || stored === undefined) {
		return emptyConfiguration();
	}

	const parsed = parseStoredConfiguration(stored);
	if (!parsed.ok) {
		return emptyConfiguration();
	}
	return parsed.value;
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
