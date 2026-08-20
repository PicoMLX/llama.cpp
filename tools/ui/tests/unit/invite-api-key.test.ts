import { getInviteApiKeyFromLocation } from '$lib/utils/invite-api-key';
import { describe, expect, it } from 'vitest';

function location(search: string, hash: string): Pick<Location, 'search' | 'hash'> {
	return { hash, search };
}

describe('getInviteApiKeyFromLocation', () => {
	it('reads apikey from the regular query string', () => {
		expect(getInviteApiKeyFromLocation(location('?apikey=abc123', ''))).toBe('abc123');
	});

	it('reads apikey from invite hash query variants', () => {
		expect(getInviteApiKeyFromLocation(location('', '#?apikey=abc123'))).toBe('abc123');
		expect(getInviteApiKeyFromLocation(location('', '#/?apikey=abc123'))).toBe('abc123');
		expect(getInviteApiKeyFromLocation(location('', '#apikey=abc123'))).toBe('abc123');
		expect(getInviteApiKeyFromLocation(location('', '#/apikey=abc123'))).toBe('abc123');
	});

	it('reads apikey from routed hash query strings', () => {
		expect(getInviteApiKeyFromLocation(location('', '#/chat/42?foo=bar&apikey=abc123'))).toBe(
			'abc123'
		);
	});

	it('trims the parsed token and ignores missing values', () => {
		expect(getInviteApiKeyFromLocation(location('?apikey=%20abc123%20', ''))).toBe('abc123');
		expect(getInviteApiKeyFromLocation(location('', '#/chat/42?foo=bar'))).toBeNull();
	});
});
