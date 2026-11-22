import SettingsChat from '$lib/components/app/settings/SettingsChat/SettingsChat.svelte';
import { CONFIG_LOCALSTORAGE_KEY, IS_PICO_BUILD, SETTINGS_SECTION_SLUGS } from '$lib/constants';
import { ServerRole } from '$lib/enums';
import { mcpStore } from '$lib/stores/mcp/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

beforeEach(async () => {
	localStorage.removeItem(CONFIG_LOCALSTORAGE_KEY);
	settingsStore.initialize();
	serverStore.role = ServerRole.MODEL;
	await page.viewport(1280, 900);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.skipIf(!IS_PICO_BUILD)('Connections settings', () => {
	it('opens the existing connection setup from Settings', async () => {
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.CONNECTIONS });

		await expect.element(screen.getByRole('heading', { name: 'Connections' })).toBeVisible();
		await screen.getByRole('button', { exact: true, name: 'Add connection' }).click();
		await expect.element(page.getByRole('dialog', { name: 'Add connection' })).toBeVisible();
	});

	it('saves a new connection immediately without a second settings save', async () => {
		vi.spyOn(mcpStore, 'runHealthCheck').mockResolvedValue();
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.CONNECTIONS });

		await screen.getByRole('button', { exact: true, name: 'Add connection' }).click();
		await page.getByRole('textbox', { name: 'Server URL' }).fill('https://example.com/mcp');
		await page.getByRole('textbox', { name: 'Display name' }).fill('My connection');
		await page.getByRole('button', { exact: true, name: 'Connect' }).click();

		await expect
			.poll(() => mcpStore.getServers())
			.toEqual([
				expect.objectContaining({ displayName: 'My connection', url: 'https://example.com/mcp' })
			]);
		await expect
			.element(screen.getByRole('button', { name: 'Save settings' }))
			.not.toBeInTheDocument();
	});
});

describe.skipIf(IS_PICO_BUILD)('settings drafts', () => {
	it('preserves immediate connection and access-key changes when another preference is saved', async () => {
		const sendOnEnter = settingsStore.config.sendOnEnter;
		const screen = render(SettingsChat);

		mcpStore.addServer({
			displayName: 'Saved connection',
			enabled: false,
			headers: JSON.stringify({ Authorization: 'Bearer connection-token' }),
			id: 'saved-connection',
			url: 'https://example.com/mcp'
		});
		settingsStore.updateConfig('apiKey', 'updated-access-key');
		const savedConnections = settingsStore.config.mcpServers;

		await expect
			.element(screen.getByRole('button', { name: 'Save settings' }))
			.not.toBeInTheDocument();
		await screen.getByRole('checkbox', { name: 'Send message on Enter' }).click();
		await screen.getByRole('button', { name: 'Save settings' }).click();

		expect(settingsStore.config.sendOnEnter).toBe(!sendOnEnter);
		expect(settingsStore.config.mcpServers).toBe(savedConnections);
		expect(settingsStore.config.apiKey).toBe('updated-access-key');
		const persisted = JSON.parse(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY) ?? '{}');

		expect(persisted.mcpServers).toBe(savedConnections);
		expect(persisted.apiKey).toBe('updated-access-key');
		await expect
			.element(screen.getByRole('button', { name: 'Save settings' }))
			.not.toBeInTheDocument();
	});
});
