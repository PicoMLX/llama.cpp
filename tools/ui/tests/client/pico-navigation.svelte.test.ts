import PicoNavigationHarness from './components/PicoNavigationHarness.svelte';
import { goto } from '$app/navigation';
import { CONVERSATION_TABS_LOCALSTORAGE_KEY, IS_PICO_BUILD } from '$lib/constants';
import { SidebarAction } from '$lib/enums';
import { useKeyboardShortcuts } from '$lib/hooks/use-keyboard-shortcuts.svelte';
import { MigrationService } from '$lib/services/migration.service';
import {
	conversationsStore,
	groupsStore,
	permissionsStore,
	settingsStore,
	tabsStore,
	toolsStore,
	versionStore
} from '$lib/stores';
import { initStores } from '$lib/stores/init';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: vi.fn()
}));

const conversation: DatabaseConversation = {
	currNode: null,
	id: 'pico-navigation-chat',
	lastModified: 1,
	name: 'Navigation test'
};

beforeEach(() => {
	settingsStore.config.conversationTabs = true;
});

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.removeItem(CONVERSATION_TABS_LOCALSTORAGE_KEY);
});

describe.runIf(IS_PICO_BUILD)('Pico navigation with legacy tabs enabled', () => {
	it('limits primary navigation to New chat and Search', async () => {
		const screen = render(PicoNavigationHarness);

		await expect.element(screen.getByRole('button', { name: /^New chat/ })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: /^Search/ })).toBeVisible();
		expect(screen.container.textContent).not.toMatch(/Models|MCP|Settings/);
	});

	it('keeps Settings in its own footer', async () => {
		const onAction = vi.fn();
		const screen = render(PicoNavigationHarness, { footer: true, onAction });

		await screen.getByRole('button', { name: /^Settings/ }).click();

		expect(onAction).toHaveBeenCalledWith(SidebarAction.SETTINGS);
		expect(screen.container.textContent).not.toMatch(/New chat|Search|Models|MCP/);
	});

	it('uses normal conversation navigation for modifier clicks', async () => {
		const onSelect = vi.fn();
		const openTab = vi.spyOn(tabsStore, 'openInNewTab');
		const screen = render(PicoNavigationHarness, { conversation, onSelect });
		const row = screen.container.querySelector<HTMLButtonElement>('button');

		expect(row).not.toBeNull();
		row!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
		row!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
		await tick();

		expect(onSelect).toHaveBeenCalledWith(conversation.id);
		expect(openTab).not.toHaveBeenCalled();
	});

	it('leaves tab shortcuts to the browser', () => {
		const navigateToPrevTab = vi.fn();
		const navigateToNextTab = vi.fn();
		const closeTab = vi.spyOn(tabsStore, 'close');
		const { handleKeydown } = useKeyboardShortcuts({
			navigateToNextTab,
			navigateToPrevTab
		});
		const events = [
			new KeyboardEvent('keydown', {
				cancelable: true,
				ctrlKey: true,
				key: 'X',
				shiftKey: true
			}),
			...['BracketLeft', 'BracketRight'].map(
				(code) =>
					new KeyboardEvent('keydown', {
						altKey: true,
						cancelable: true,
						code,
						ctrlKey: true,
						shiftKey: true
					})
			)
		];

		for (const event of events) {
			handleKeydown(event);
			expect(event.defaultPrevented).toBe(false);
		}

		expect(navigateToPrevTab).not.toHaveBeenCalled();
		expect(navigateToNextTab).not.toHaveBeenCalled();
		expect(closeTab).not.toHaveBeenCalled();
	});

	it('ignores saved tab order and returns to New chat when the active chat is removed', async () => {
		localStorage.setItem(
			CONVERSATION_TABS_LOCALSTORAGE_KEY,
			JSON.stringify(['old-chat', conversation.id])
		);
		vi.spyOn(MigrationService, 'runAllMigrations').mockResolvedValue();
		vi.spyOn(settingsStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(permissionsStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(toolsStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(versionStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(conversationsStore, 'initialize').mockResolvedValue();
		vi.spyOn(groupsStore, 'initialize').mockResolvedValue();
		const initializeTabs = vi.spyOn(tabsStore, 'init');

		await initStores();
		await tick();

		expect(initializeTabs).not.toHaveBeenCalled();
		expect(tabsStore.openTabs).toEqual([]);
		await tabsStore.closeConversation(conversation.id);
		expect(goto).toHaveBeenCalledWith('#/');
	});
});
