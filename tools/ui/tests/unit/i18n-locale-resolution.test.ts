import { canonicalizeLocale, getLocaleCandidates } from '$lib/i18n/locale-utils';
import { describe, expect, it } from 'vitest';

describe('canonicalizeLocale', () => {
	it('canonicalizes locale casing', () => {
		expect(canonicalizeLocale('en-us')).toBe('en-US');
		expect(canonicalizeLocale('es-419')).toBe('es-419');
		expect(canonicalizeLocale('zh-hans')).toBe('zh-Hans');
		expect(canonicalizeLocale('zh_Hant')).toBe('zh-Hant');
	});
});

describe('getLocaleCandidates', () => {
	it('keeps exact script locale for zh-Hans', () => {
		expect(getLocaleCandidates('zh-Hans')[0]).toBe('zh-Hans');
	});

	it('keeps exact script locale for zh-Hant', () => {
		expect(getLocaleCandidates('zh-Hant')[0]).toBe('zh-Hant');
	});

	it('maps zh-CN to zh-Hans before base language fallback', () => {
		const candidates = getLocaleCandidates('zh-CN');

		expect(candidates).toContain('zh-Hans');
		expect(candidates.indexOf('zh-Hans')).toBeGreaterThan(candidates.indexOf('zh-CN'));
	});

	it('maps zh-TW to zh-Hant', () => {
		expect(getLocaleCandidates('zh-TW')).toContain('zh-Hant');
	});

	it('maps zh-HK to zh-HK then zh-Hant', () => {
		const candidates = getLocaleCandidates('zh-HK');

		expect(candidates[0]).toBe('zh-HK');
		expect(candidates[1]).toBe('zh-Hant');
	});

	it('maps generic zh to zh-Hans', () => {
		const candidates = getLocaleCandidates('zh');

		expect(candidates[0]).toBe('zh');
		expect(candidates[1]).toBe('zh-Hans');
	});
});
