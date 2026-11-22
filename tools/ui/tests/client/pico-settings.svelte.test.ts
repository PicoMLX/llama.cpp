import SettingsChat from '$lib/components/app/settings/SettingsChat/SettingsChat.svelte';
import {
	CONFIG_LOCALSTORAGE_KEY,
	IS_PICO_BUILD,
	SETTINGS_CHAT_SECTIONS,
	SETTINGS_KEYS,
	SETTINGS_REGISTRY,
	SETTINGS_SECTION_SLUGS
} from '$lib/constants';
import { ServerRole } from '$lib/enums';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const connection = {
	enabled: false,
	headers: JSON.stringify({ Authorization: 'Bearer saved-tool-token' }),
	id: 'saved-connection',
	url: 'https://example.com/mcp'
};

beforeEach(async () => {
	localStorage.removeItem(CONFIG_LOCALSTORAGE_KEY);
	serverStore.props = null;
	serverStore.role = ServerRole.MODEL;
	settingsStore.initialize();
	await page.viewport(1280, 900);
});

afterEach(() => vi.restoreAllMocks());

describe.runIf(IS_PICO_BUILD)('Pico preferences', () => {
	it('projects five sections without removing stored technical settings', () => {
		expect(SETTINGS_CHAT_SECTIONS.map((section) => section.slug)).toEqual([
			'general',
			'personalization',
			'connections',
			'data',
			'advanced'
		]);
		expect(
			SETTINGS_REGISTRY.flatMap((section) => section.settings).some(
				(setting) => setting.key === SETTINGS_KEYS.CUSTOM_JSON
			)
		).toBe(true);
	});

	it('saves valid preferences immediately while preserving connections and credentials', async () => {
		settingsStore.updateMultipleConfig({
			apiKey: 'saved-access-key',
			mcpServers: JSON.stringify([connection])
		});
		const screen = render(SettingsChat);
		const previous = settingsStore.config.sendOnEnter;

		await screen.getByRole('checkbox', { name: 'Send message on Enter' }).click();

		expect(settingsStore.config.sendOnEnter).toBe(!previous);
		expect(settingsStore.config.apiKey).toBe('saved-access-key');
		expect(JSON.parse(String(settingsStore.config.mcpServers))).toEqual([connection]);
		await expect
			.element(screen.getByRole('button', { name: 'Save settings' }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('textbox', { name: 'System Message' }))
			.not.toBeInTheDocument();
	});

	it('saves custom instructions while the field remains focused', async () => {
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.PERSONALIZATION });

		await screen
			.getByRole('textbox', { name: 'Custom instructions' })
			.fill('Use short paragraphs.');

		expect(settingsStore.config.systemMessage).toBe('Use short paragraphs.');
		await expect
			.element(screen.getByRole('checkbox', { name: 'Show system message in conversations' }))
			.not.toBeInTheDocument();
	});

	it('keeps invalid numeric drafts out of storage and accepts a model-default reset', async () => {
		settingsStore.updateConfig('temperature', 0.7);
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.ADVANCED });

		await screen.getByText('Generation', { exact: true }).click();
		const temperature = screen.getByLabelText('Temperature', { exact: true });

		await temperature.fill('invalid');
		await expect.element(temperature).toHaveAttribute('aria-invalid', 'true');
		expect(settingsStore.config.temperature).toBe(0.7);
		await temperature.fill('0.');
		await expect.element(temperature).toHaveValue('0.');
		await temperature.fill('0.4');
		expect(settingsStore.config.temperature).toBe(0.4);
		await temperature.fill('');
		expect(settingsStore.config.temperature).toBe('');
		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
	});

	it('preserves the saved JSON value until a valid replacement is entered', async () => {
		settingsStore.updateConfig('customJson', '{"seed":1}');
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.ADVANCED });

		await screen.getByText('Developer', { exact: true }).click();
		const json = screen.getByLabelText('Custom JSON', { exact: true });

		await json.fill('{');
		await expect.element(screen.getByRole('alert')).toHaveTextContent('Enter valid JSON');
		expect(settingsStore.config.customJson).toBe('{"seed":1}');
		await json.fill('{"seed":2}');
		expect(settingsStore.config.customJson).toBe('{"seed":2}');
	});

	it('resets General without clearing instructions, connections or access', async () => {
		settingsStore.updateMultipleConfig({
			apiKey: 'saved-access-key',
			mcpServers: JSON.stringify([connection]),
			sendOnEnter: false,
			systemMessage: 'Keep this instruction.'
		});
		const screen = render(SettingsChat);

		await screen.getByRole('button', { exact: true, name: 'Reset General' }).click();
		await expect
			.element(page.getByRole('alertdialog', { name: 'Reset General settings?' }))
			.toBeVisible();
		await page.getByRole('button', { exact: true, name: 'Reset to Default' }).click();

		expect(settingsStore.config.sendOnEnter).toBe(true);
		expect(settingsStore.config.systemMessage).toBe('Keep this instruction.');
		expect(settingsStore.config.apiKey).toBe('saved-access-key');
		expect(JSON.parse(String(settingsStore.config.mcpServers))).toEqual([connection]);
	});

	it('validates an access-key replacement before saving it', async () => {
		settingsStore.updateConfig('apiKey', 'working-key');
		const fetch = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 401 }));
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.CONNECTIONS });

		await screen.getByText('Pico access', { exact: true }).click();
		const key = screen.getByLabelText('Access key', { exact: true });

		await key.fill('rejected-key');
		expect(settingsStore.config.apiKey).toBe('working-key');
		await screen.getByRole('button', { exact: true, name: 'Connect' }).click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent('This access key is not valid');
		expect(settingsStore.config.apiKey).toBe('working-key');
		fetch.mockResolvedValue(new Response('{}', { status: 200 }));
		await key.fill('accepted-key');
		await screen.getByRole('button', { exact: true, name: 'Connect' }).click();
		await expect.element(screen.getByRole('status')).toHaveTextContent('Connected to Pico.');
		expect(settingsStore.config.apiKey).toBe('accepted-key');
	});

	it('separates chat data from configuration backup', async () => {
		const screen = render(SettingsChat, { initialSection: SETTINGS_SECTION_SLUGS.DATA });

		await expect
			.element(screen.getByRole('button', { name: 'Export conversations' }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Export settings' }))
			.not.toBeInTheDocument();
	});
});

describe('scoped preference resets', () => {
	it('treats a blank or inherited model default as unchanged', () => {
		serverStore.props = {
			default_generation_settings: { params: { temperature: 0.8 } }
		} as typeof serverStore.props;
		settingsStore.updateConfig('temperature', undefined);
		expect(settingsStore.hasCustomSettingsForKeys(['temperature'])).toBe(false);
		settingsStore.updateConfig('temperature', 0.8);
		expect(settingsStore.hasCustomSettingsForKeys(['temperature'])).toBe(false);
		settingsStore.updateConfig('temperature', 0.3);
		expect(settingsStore.hasCustomSettingsForKeys(['temperature'])).toBe(true);
	});

	it('protects credentials and connections even when they are included in a reset key list', () => {
		settingsStore.updateMultipleConfig({
			apiKey: 'working-key',
			mcpServers: JSON.stringify([connection]),
			sendOnEnter: false,
			temperature: 0.3
		});
		settingsStore.resetSettingsForKeys(['sendOnEnter', 'apiKey', 'mcpServers']);

		expect(settingsStore.config.sendOnEnter).toBe(true);
		expect(settingsStore.config.apiKey).toBe('working-key');
		expect(JSON.parse(String(settingsStore.config.mcpServers))).toEqual([connection]);
		expect(settingsStore.config.temperature).toBe(0.3);
	});
});

describe.runIf(IS_PICO_BUILD)('Pico settings import preservation', () => {
	it('retains access credentials omitted from a normal backup', () => {
		settingsStore.updateMultipleConfig({
			apiKey: 'working-key',
			mcpServers: JSON.stringify([connection])
		});
		const backup = settingsStore.exportSettings();

		settingsStore.importSettings(backup);

		expect(settingsStore.config.apiKey).toBe('working-key');
		expect(JSON.parse(String(settingsStore.config.mcpServers))).toEqual([connection]);
	});

	it('does not copy existing credentials onto a changed connection URL', () => {
		settingsStore.updateConfig('mcpServers', JSON.stringify([connection]));
		const backup = settingsStore.exportSettings();

		backup.config.mcpServers = JSON.stringify([
			{ ...connection, headers: undefined, url: 'https://other.example/mcp' }
		]);
		settingsStore.importSettings(backup);

		expect(JSON.parse(String(settingsStore.config.mcpServers))[0].headers).toBeUndefined();
	});
});
