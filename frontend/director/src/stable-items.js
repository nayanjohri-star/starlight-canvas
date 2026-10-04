// Stable collection identities. Parsing uses content-derived IDs so legacy
// documents repair repeatably; editor-created items use a process-local suffix.

let generatedSequence = 1;

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (!value || typeof value !== "object") return JSON.stringify(value);
	return `{${Object.keys(value).filter((key) => key !== "id").sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function hash(value) {
	let result = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16777619);
	}
	return (result >>> 0).toString(36);
}

export class UnknownStableItemIdError extends Error {
	constructor(collection, id) {
		super(`Unknown ${collection} ID: ${id}`);
		this.name = "UnknownStableItemIdError";
	}
}

export function createStableItemId(collection) {
	return `${collection}-${Date.now().toString(36)}-${generatedSequence++}`;
}

function hasUsableId(value) {
	return typeof value === "string" && value.trim() !== "";
}

/** Clone records with a unique deterministic id for every valid input entry. */
export function normalizeStableItems(entries, collection, occupied = new Set()) {
	const seen = occupied;
	const duplicateCounts = new Map();
	return (Array.isArray(entries) ? entries : []).map((entry) => {
		const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
		const storedId = hasUsableId(source.id) ? source.id : null;
		if (storedId && !seen.has(storedId)) {
			seen.add(storedId);
			return { ...source, id: storedId };
		}
		const base = `${collection}-${hash(canonical(source))}`;
		const occurrence = duplicateCounts.get(base) ?? 0;
		duplicateCounts.set(base, occurrence + 1);
		let id = occurrence === 0 ? base : `${base}-${occurrence + 1}`;
		while (seen.has(id)) {
			const next = duplicateCounts.get(base) ?? 0;
			duplicateCounts.set(base, next + 1);
			id = `${base}-${next + 1}`;
		}
		seen.add(id);
		return { ...source, id };
	});
}

export function requireStableItem(items, id, collection) {
	const item = Array.isArray(items) ? items.find((entry) => entry.id === id) : undefined;
	if (!item) throw new UnknownStableItemIdError(collection, id);
	return item;
}

export function updateStableItem(items, id, update, collection) {
	requireStableItem(items, id, collection);
	return items.map((item) => item.id === id ? update(item) : item);
}

export function removeStableItem(items, id, collection) {
	requireStableItem(items, id, collection);
	return items.filter((item) => item.id !== id);
}

export function insertStableItemBefore(items, targetId, inserted, collection) {
	const target = requireStableItem(items, targetId, collection);
	if (!hasUsableId(inserted?.id) || items.some((item) => item.id === inserted.id)) {
		throw new Error(`Duplicate ${collection} ID: ${inserted?.id ?? ""}`);
	}
	return items.flatMap((item) => item === target ? [inserted, item] : [item]);
}
