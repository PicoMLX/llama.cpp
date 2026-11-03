import type { PicoCardAction } from '../../types';

const userActions = new WeakSet<object>();

export function isOpenUIUserAction(value: unknown): value is PicoCardAction {
	return value !== null && typeof value === 'object' && userActions.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

	const prototype = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
}

function validJSON(value: unknown, depth = 0): boolean {
	if (depth > 16) return false;

	if (value === null || typeof value === 'boolean') return true;

	if (typeof value === 'number') return Number.isFinite(value);

	if (typeof value === 'string') return value.length <= 100_000;

	if (Array.isArray(value))
		return value.length <= 4096 && value.every((item) => validJSON(item, depth + 1));

	if (!isRecord(value)) return false;

	const entries = Object.entries(value);

	return (
		entries.length <= 256 &&
		entries.every(
			([key, item]) =>
				!['__proto__', 'constructor', 'prototype'].includes(key) && validJSON(item, depth + 1)
		)
	);
}

export function normalizeOpenUIAction(
	value: unknown,
	userInitiated = false
): PicoCardAction | null {
	if (
		!isRecord(value) ||
		typeof value.type !== 'string' ||
		!['continue_conversation', 'open_url'].includes(value.type)
	)
		return null;

	if (!validJSON(value) || JSON.stringify(value).length > 100_000) return null;

	if (value.params !== undefined && !isRecord(value.params)) return null;

	if (value.formState !== undefined && !isRecord(value.formState)) return null;

	if (value.humanFriendlyMessage !== undefined && typeof value.humanFriendlyMessage !== 'string')
		return null;

	if (value.formName !== undefined && typeof value.formName !== 'string') return null;

	const action: PicoCardAction = { type: value.type };

	if (value.params !== undefined) action.params = value.params;

	if (value.formState !== undefined) action.formState = value.formState;

	if (typeof value.humanFriendlyMessage === 'string')
		action.humanFriendlyMessage = value.humanFriendlyMessage;

	if (typeof value.formName === 'string') action.formName = value.formName;

	if (userInitiated) userActions.add(action);

	return action;
}
