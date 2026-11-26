import '../../src/app.css';
import PicoNavigationHarness from './components/PicoNavigationHarness.svelte';
import SidebarNavigationHarness from './components/SidebarNavigationHarness.svelte';
import { goto } from '$app/navigation';
import { CONVERSATION_TABS_LOCALSTORAGE_KEY, IS_PICO_BUILD, ROUTES } from '$lib/constants';
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
	uiStore,
	versionStore
} from '$lib/stores';
import { initStores } from '$lib/stores/init';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
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

describe.runIf(IS_PICO_BUILD)('Pico collapsed sidebar actions', () => {
	let wasExpanded: boolean;
	let previousConversations: DatabaseConversation[];
	let previousGroups: typeof groupsStore.groups;

	beforeEach(async () => {
		wasExpanded = uiStore.isSidebarExpanded;
		previousConversations = conversationsStore.conversations;
		previousGroups = groupsStore.groups;
		uiStore.isSidebarExpanded = false;
		conversationsStore.conversations = [conversation];
		groupsStore.groups = [];
		await page.viewport(1280, 900);
	});

	afterEach(() => {
		uiStore.isSidebarExpanded = wasExpanded;
		conversationsStore.conversations = previousConversations;
		groupsStore.groups = previousGroups;
	});

	it.each([1280, 390].flatMap((width) => [false, true].map((expanded) => ({ expanded, width }))))(
		'keeps Pico beside the toggle at width $width with expanded=$expanded',
		async ({ expanded, width }) => {
			await page.viewport(width, 900);
			uiStore.isSidebarExpanded = expanded;
			const screen = render(SidebarNavigationHarness);

			await expect.element(screen.getByText('Pico', { exact: true })).toBeVisible();
			const aside = screen.container.querySelector('aside')!;
			const brand = aside.querySelector<HTMLElement>('[data-slot="pico-brand"]')!;
			const toggle = aside.querySelector<HTMLButtonElement>(
				`[aria-label="${expanded ? 'Collapse' : 'Expand'} navigation"]`
			)!;
			const brandBox = brand.getBoundingClientRect();
			const toggleBox = toggle.getBoundingClientRect();
			const logoBox = brand.querySelector('svg')!.getBoundingClientRect();

			expect(brand.textContent?.trim()).toBe('Pico');
			expect(brand.closest('button, a')).toBeNull();
			expect(getComputedStyle(brand).pointerEvents).toBe('none');
			expect(logoBox.width).toBe(24);
			expect(logoBox.height).toBe(24);
			expect(toggleBox.width).toBeGreaterThanOrEqual(44);
			expect(toggleBox.height).toBeGreaterThanOrEqual(44);
			expect(brandBox.left).toBeGreaterThanOrEqual(toggleBox.right);
			expect(brandBox.left - toggleBox.right).toBeLessThanOrEqual(12);
			expect(
				Math.abs(brandBox.top + brandBox.height / 2 - toggleBox.top - toggleBox.height / 2)
			).toBeLessThan(1);
			expect(brandBox.right).toBeLessThan(width);

			if (!expanded && width > 768) {
				expect(brandBox.right).toBeGreaterThan(aside.getBoundingClientRect().right);
				expect(
					aside.contains(
						document.elementFromPoint(
							brandBox.left + brandBox.width / 2,
							brandBox.top + brandBox.height / 2
						)
					)
				).toBe(false);
			}

			let previousRight = brandBox.right;

			for (const name of ['New chat', 'Search']) {
				await expect
					.element(screen.getByRole('button', { name: new RegExp(`^${name}`) }))
					.toBeVisible();
				const button =
					aside.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ??
					[...aside.querySelectorAll('button')].find((item) =>
						item.textContent?.trim().startsWith(name)
					)!;
				const box = button.getBoundingClientRect();

				expect(box.left).toBeGreaterThanOrEqual(0);
				expect(box.right).toBeLessThanOrEqual(width);
				expect(box.top >= brandBox.bottom || box.left >= brandBox.right).toBe(true);
				expect(
					document
						.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
						?.closest('button')
				).toBe(button);

				if (width < 768) {
					expect(box.width).toBeGreaterThanOrEqual(44);
					expect(box.height).toBeGreaterThanOrEqual(44);
					expect(box.left).toBeGreaterThanOrEqual(previousRight);
					expect(
						Math.abs(box.top + box.height / 2 - toggleBox.top - toggleBox.height / 2)
					).toBeLessThan(1);
					previousRight = box.right;
				}
			}
		}
	);

	it('keeps both icon actions clickable while history and Settings remain inert', async () => {
		const newChat = vi.spyOn(conversationsStore, 'openNewChat').mockResolvedValue();
		const screen = render(SidebarNavigationHarness);

		await expect
			.element(screen.getByRole('button', { exact: true, name: 'New chat' }))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { exact: true, name: 'Search' })).toBeVisible();
		const aside = screen.container.querySelector('aside')!;

		await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(48);
		for (const name of ['New chat', 'Search']) {
			const button = aside.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
			const box = button.getBoundingClientRect();
			const rail = aside.getBoundingClientRect();

			expect(button.textContent?.trim()).toBe('');
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.left).toBeGreaterThanOrEqual(rail.left);
			expect(box.right).toBeLessThanOrEqual(rail.right);
			expect(
				document
					.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
					?.closest('button')
			).toBe(button);
		}
		const history = aside.querySelector('[data-conversation-row]')!;
		const protectedBody = history.closest<HTMLElement>('[inert]')!;

		expect(protectedBody).not.toBeNull();
		expect(protectedBody.textContent).toContain('Settings');
		await expect.poll(() => getComputedStyle(protectedBody).opacity).toBe('0');
		const historyBox = history.getBoundingClientRect();

		expect(
			protectedBody.contains(
				document.elementFromPoint(
					historyBox.left + historyBox.width / 2,
					historyBox.top + historyBox.height / 2
				)
			)
		).toBe(false);
		await screen.getByRole('button', { exact: true, name: 'New chat' }).click();
		expect(newChat).toHaveBeenCalledWith({ inNewTab: true });
		expect(uiStore.isSidebarExpanded).toBe(false);
	});

	it('opens Search from the collapsed rail without expanding the sidebar', async () => {
		const screen = render(SidebarNavigationHarness);

		await screen.getByRole('button', { exact: true, name: 'Search' }).click();
		await expect.element(page.getByRole('dialog', { exact: true, name: 'Search' })).toBeVisible();
		expect(uiStore.isSidebarExpanded).toBe(false);
	});

	it('restores labeled actions and history when expanded', async () => {
		const screen = render(SidebarNavigationHarness);

		await screen.getByRole('button', { name: 'Expand navigation' }).click();
		await expect.element(screen.getByText('New chat', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('Search', { exact: true })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: /^Settings/ })).toBeVisible();
		await expect.element(screen.getByText(conversation.name, { exact: true })).toBeVisible();
		expect(screen.container.querySelector('[inert]')).toBeNull();
	});

	it('keeps mobile icon actions clickable without expanding or intercepting the rest of the header', async () => {
		await page.viewport(390, 844);
		const newChat = vi.spyOn(conversationsStore, 'openNewChat').mockResolvedValue();
		const screen = render(SidebarNavigationHarness);

		vi.mocked(goto).mockClear();
		await expect.element(screen.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { exact: true, name: 'New chat' }))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { exact: true, name: 'Search' })).toBeVisible();
		const aside = screen.container.querySelector('aside')!;
		const toggle = aside.querySelector('[aria-label="Expand navigation"]')!.getBoundingClientRect();

		let previousRight = toggle.right;

		for (const name of ['New chat', 'Search']) {
			const button = aside.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
			const box = button.getBoundingClientRect();

			expect(button.textContent?.trim()).toBe('');
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.left).toBeGreaterThanOrEqual(previousRight);
			expect(Math.abs(box.top + box.height / 2 - toggle.top - toggle.height / 2)).toBeLessThan(1);
			expect(
				document
					.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
					?.closest('button')
			).toBe(button);
			previousRight = box.right;
		}
		const rail = aside.getBoundingClientRect();

		expect(
			aside.contains(document.elementFromPoint(rail.right - 24, toggle.top + toggle.height / 2))
		).toBe(false);
		expect(aside.querySelector('[data-conversation-row]')?.closest('[inert]')).not.toBeNull();
		await screen.getByRole('button', { exact: true, name: 'Search' }).click();
		expect(goto).toHaveBeenCalledWith(ROUTES.SEARCH);
		expect(uiStore.isSidebarExpanded).toBe(false);
		await screen.getByRole('button', { exact: true, name: 'New chat' }).click();
		expect(newChat).toHaveBeenCalledWith({ inNewTab: true });
		expect(uiStore.isSidebarExpanded).toBe(false);
	});
});
