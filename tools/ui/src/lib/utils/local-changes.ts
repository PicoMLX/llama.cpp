/**
 * Keeps this window's changes through a reload of a list. The store may have
 * read the list before this window's writes landed, so records this window
 * added, changed or removed while the read ran keep this window's state.
 */

/** Each record as JSON by id, taken when a read begins. */
export function snapshotById(records: readonly { id: string }[]): Map<string, string> {
	return new Map(records.map((record) => [record.id, JSON.stringify(record)]));
}

/**
 * The list a read returned, with the records that changed in `current` since
 * `before` as this window has them.
 *
 * @param before - {@link snapshotById} of the list when the read began
 * @param current - The list as this window has it now
 * @param read - The list the read returned
 * @param order - Sorts the result when it mixes both lists
 */
export function keepLocalChanges<T extends { id: string }>(
	before: Map<string, string>,
	current: T[],
	read: T[],
	order: (a: T, b: T) => number
): T[] {
	const after = snapshotById(current);
	const touched = new Set(
		[...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id))
	);

	if (touched.size === 0) return read;

	return [
		...read.filter((record) => !touched.has(record.id)),
		...current.filter((record) => touched.has(record.id))
	].sort(order);
}
