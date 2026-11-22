import { CONFIG_LOCALSTORAGE_KEY, IS_PICO_BUILD } from '$lib/constants';
import { PICO_RETIRED_VISUAL_DEFAULTS } from '$lib/constants/settings.constants';
import { MigrationService } from '$lib/services/migration.service';
import { beforeEach, describe, expect, it } from 'vitest';

const backupKey = `${CONFIG_LOCALSTORAGE_KEY}.pico-ux-v1-backup`;
const migration = MigrationService.getMigrations().find(
	(entry) => entry.id === 'pico-chat-presentation-v1'
);

beforeEach(() => {
	localStorage.removeItem(CONFIG_LOCALSTORAGE_KEY);
	localStorage.removeItem(backupKey);
});

describe.runIf(IS_PICO_BUILD)('Pico presentation migration', () => {
	it('changes retired presentation preferences while preserving connection and chat configuration', async () => {
		const config = {
			apiKey: 'saved-access-key',
			conversationTabs: true,
			customJson: '{"temperature":0.6}',
			mcpServers: '[{"id":"saved","headers":"private-header"}]',
			showModelQuantization: true,
			systemMessage: 'Saved custom instructions',
			temperature: 0.7,
			unknownSetting: 'preserve-me'
		};

		localStorage.setItem(CONFIG_LOCALSTORAGE_KEY, JSON.stringify(config));
		await migration!.run();

		expect(JSON.parse(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY)!)).toEqual({
			...config,
			...PICO_RETIRED_VISUAL_DEFAULTS
		});
		expect(JSON.parse(localStorage.getItem(backupKey)!)).toEqual({
			conversationTabs: true,
			showModelQuantization: true
		});
	});

	it('preserves the original presentation backup on repeated runs', async () => {
		localStorage.setItem(CONFIG_LOCALSTORAGE_KEY, JSON.stringify({ conversationTabs: true }));
		await migration!.run();
		const backup = localStorage.getItem(backupKey);
		const config = JSON.parse(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY)!);

		config.systemMessage = 'Updated instructions';
		localStorage.setItem(CONFIG_LOCALSTORAGE_KEY, JSON.stringify(config));
		await migration!.run();

		expect(localStorage.getItem(backupKey)).toBe(backup);
		expect(JSON.parse(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY)!).systemMessage).toBe(
			'Updated instructions'
		);
	});

	it('keeps a new browser eligible for first-visit server defaults', async () => {
		await migration!.run();
		expect(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY)).toBeNull();
		expect(localStorage.getItem(backupKey)).toBeNull();
	});

	it('leaves malformed saved configuration untouched so a migration failure is recoverable', async () => {
		localStorage.setItem(CONFIG_LOCALSTORAGE_KEY, '{invalid');
		await expect(migration!.run()).rejects.toThrow();
		expect(localStorage.getItem(CONFIG_LOCALSTORAGE_KEY)).toBe('{invalid');
		expect(localStorage.getItem(backupKey)).toBeNull();
	});
});

it.runIf(!IS_PICO_BUILD)('does not register a Pico migration in generic llama.cpp builds', () => {
	expect(migration).toBeUndefined();
});
