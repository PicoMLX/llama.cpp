const DEFAULT_LOCALE = 'en';

function fallbackCanonicalize(value: string): string {
	const normalized = value.replace(/_/g, '-');
	const parts = normalized.split('-').filter(Boolean);

	if (parts.length === 0) {
		return DEFAULT_LOCALE;
	}

	const [language, ...subtags] = parts;
	const formattedSubtags = subtags.map((subtag) => {
		if (/^[a-z]{4}$/i.test(subtag)) {
			return `${subtag[0].toUpperCase()}${subtag.slice(1).toLowerCase()}`;
		}

		if (/^[a-z]{2}$/i.test(subtag)) {
			return subtag.toUpperCase();
		}

		if (/^\d{3}$/.test(subtag)) {
			return subtag;
		}

		return subtag;
	});

	return [language.toLowerCase(), ...formattedSubtags].join('-');
}

export function canonicalizeLocale(input: string): string {
	const trimmed = input.trim();

	if (!trimmed) return DEFAULT_LOCALE;

	const normalized = trimmed.replace(/_/g, '-');

	try {
		const [canonical] = Intl.getCanonicalLocales(normalized);

		return canonical || DEFAULT_LOCALE;
	} catch {
		return fallbackCanonicalize(normalized);
	}
}

function getChineseFallbacks(locale: string): string[] {
	switch (locale) {
		case 'zh':
		case 'zh-CN':
		case 'zh-SG':
			return ['zh-Hans'];
		case 'zh-HK':
			return ['zh-Hant'];
		case 'zh-TW':
		case 'zh-MO':
			return ['zh-Hant'];
		default:
			return [];
	}
}

export function getLocaleCandidates(input: string): string[] {
	const locale = canonicalizeLocale(input);
	const candidates: string[] = [locale];

	for (const mapped of getChineseFallbacks(locale)) {
		if (!candidates.includes(mapped)) {
			candidates.push(mapped);
		}
	}

	const baseLocale = locale.split('-')[0];

	if (baseLocale && baseLocale !== locale && !candidates.includes(baseLocale)) {
		candidates.push(baseLocale);
	}

	if (!candidates.includes(DEFAULT_LOCALE)) {
		candidates.push(DEFAULT_LOCALE);
	}

	return candidates;
}
