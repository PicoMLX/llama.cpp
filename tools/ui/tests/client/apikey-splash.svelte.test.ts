import { CONFIG_LOCALSTORAGE_KEY } from '$lib/constants';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { validateApiKey } from '$lib/utils/api-key-validation';
import { removeInviteApiKeyFromUrl } from '$lib/utils/invite-api-key';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeFetch(status: number, capture: { auth?: string | null } = {}) {
	return (async (_url: RequestInfo | URL, init?: RequestInit) => {
		capture.auth = (init?.headers as Record<string, string>)?.['Authorization'] ?? null;

		return new Response(status === 200 ? '{}' : 'Unauthorized', { status });
	}) as typeof globalThis.fetch;
}

const is401 = (err: unknown) =>
	typeof err === 'object' && err !== null && 'status' in err && err.status === 401;

describe('api key validation surfaces the splash', () => {
	const originalUrl = window.location.href;

	afterEach(() => {
		window.history.replaceState(null, '', originalUrl);
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		localStorage.removeItem(CONFIG_LOCALSTORAGE_KEY);
		settingsStore.initialize();
	});

	it('keyed server, no stored key: throws 401 so the splash shows (onboarding)', async () => {
		await expect(validateApiKey(fakeFetch(401))).rejects.toSatisfy(is401);
	});

	it('keyed server, wrong stored key: throws 401 so the splash shows', async () => {
		settingsStore.updateConfig('apiKey', 'wrong-key');
		await expect(validateApiKey(fakeFetch(401))).rejects.toSatisfy(is401);
	});

	it('open server, no stored key: passes silently', async () => {
		await expect(validateApiKey(fakeFetch(200))).resolves.toBeUndefined();
	});

	it('valid stored key: passes and sends the bearer header', async () => {
		settingsStore.updateConfig('apiKey', 'sk-good');
		const capture: { auth?: string | null } = {};

		await expect(validateApiKey(fakeFetch(200, capture))).resolves.toBeUndefined();
		expect(capture.auth).toBe('Bearer sk-good');
	});

	it('ingests and removes an invite key before the first route authentication probe', async () => {
		const { MigrationService } = await import('$lib/services/migration.service');
		const { conversationsStore } = await import('$lib/stores/conversations/index.svelte');
		const { versionStore } = await import('$lib/stores/version.svelte');
		const { loadAppRoute } = await import('$lib/stores/init');

		vi.spyOn(MigrationService, 'runAllMigrations').mockResolvedValue(undefined);
		vi.spyOn(conversationsStore, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(versionStore, 'initialize').mockImplementation(() => {});
		settingsStore.updateConfig('apiKey', 'old-key');
		window.history.replaceState(null, '', '#/chat/42?keep=1&apikey=invite-key');
		const capture: { auth?: string | null } = {};

		await loadAppRoute(fakeFetch(200, capture));

		expect(capture.auth).toBe('Bearer invite-key');
		expect(settingsStore.config.apiKey).toBe('invite-key');
		expect(JSON.parse(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY) ?? '{}').apiKey).toBe(
			'invite-key'
		);
		expect(window.location.hash).toBe('#/chat/42?keep=1');
	});

	it('removes the invite token after navigation without dropping router history state', () => {
		const navigationState = { navigation: 42, page: { custom: 'keep' } };

		window.history.replaceState(navigationState, '', '#/chat/42?keep=1&apikey=invite-key');
		removeInviteApiKeyFromUrl();

		expect(window.location.hash).toBe('#/chat/42?keep=1');
		expect(window.history.state).toEqual(navigationState);
	});
});
