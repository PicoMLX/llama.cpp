// Pages served over plain HTTP from the LAN have no crypto.randomUUID, and
// Pico Server accepts only lowercase UUID v4 ids for chats, messages and groups.

import { uuid } from '$lib/utils/uuid';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('uuid', () => {
	it('makes a v4 UUID without crypto.randomUUID', () => {
		vi.stubGlobal('crypto', {
			getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array)
		});

		const ids = Array.from({ length: 200 }, () => uuid());

		for (const id of ids) expect(id).toMatch(UUID_V4);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it('uses crypto.randomUUID when the page has it', () => {
		expect(uuid()).toMatch(UUID_V4);
	});
});
