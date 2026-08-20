import { browser } from '$app/environment';

type HashParts = {
	route: string;
	query: string;
};

function normalizeHash(hash: string): string {
	return hash.startsWith('#') ? hash.slice(1) : hash;
}

function splitHash(hash: string): HashParts | null {
	const body = normalizeHash(hash);

	if (!body) return null;

	const queryIndex = body.indexOf('?');

	if (queryIndex >= 0) {
		return {
			query: body.slice(queryIndex + 1),
			route: body.slice(0, queryIndex)
		};
	}

	// Support hash-only query payloads such as #apikey=... and #/apikey=...
	const query = body.replace(/^\/?/, '');

	if (!query.includes('=')) return null;

	return {
		query,
		route: ''
	};
}

export function getInviteApiKeyFromLocation(
	location: Pick<Location, 'search' | 'hash'>
): string | null {
	const searchToken = new URLSearchParams(location.search).get('apikey')?.trim();

	if (searchToken) return searchToken;

	const hashParts = splitHash(location.hash);

	if (!hashParts) return null;

	const hashToken = new URLSearchParams(hashParts.query).get('apikey')?.trim();

	return hashToken || null;
}

export function removeInviteApiKeyFromUrl(): void {
	if (!browser) return;

	const url = new URL(window.location.href);

	url.searchParams.delete('apikey');

	let hash = window.location.hash;

	const hashParts = splitHash(hash);

	if (hashParts) {
		const params = new URLSearchParams(hashParts.query);

		params.delete('apikey');

		const query = params.toString();

		if (hashParts.route) {
			hash = query ? `#${hashParts.route}?${query}` : `#${hashParts.route}`;
		} else {
			hash = query ? `#${query}` : '';
		}
	}

	window.history.replaceState(null, '', `${url.pathname}${url.search}${hash}`);
}

export function consumeInviteApiKeyFromUrl(): string | null {
	if (!browser) return null;

	const token = getInviteApiKeyFromLocation(window.location);

	if (!token) return null;

	removeInviteApiKeyFromUrl();

	return token;
}
