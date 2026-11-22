import '../../src/app.css';
import SidebarNavigationHarness from './components/SidebarNavigationHarness.svelte';
import PicoInlineError from '$lib/components/app/chat/ChatMessages/PicoInlineError.svelte';
import { CONFIG_LOCALSTORAGE_KEY, IS_PICO_BUILD } from '$lib/constants';
import { ErrorDialogType } from '$lib/enums';
import { chatStore, conversationsStore, groupsStore, settingsStore, uiStore } from '$lib/stores';
import type { DatabaseConversation } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const parent: DatabaseConversation = {
	currNode: null,
	id: 'history-parent',
	lastModified: 1,
	name: 'Original chat'
};
const fork: DatabaseConversation = {
	currNode: null,
	forkedFromConversationId: parent.id,
	id: 'history-fork',
	lastModified: 3,
	name: 'Newest branch'
};
const other: DatabaseConversation = {
	currNode: null,
	id: 'history-other',
	lastModified: 2,
	name: 'Another chat'
};

beforeEach(async () => {
	localStorage.removeItem(CONFIG_LOCALSTORAGE_KEY);
	settingsStore.initialize();
	uiStore.isSidebarExpanded = true;
	uiStore.chatManagementRequested = false;
	conversationsStore.conversations = [parent, fork, other];
	conversationsStore.activeConversation = parent;
	conversationsStore.activeMessages = [];
	groupsStore.groups = [];
	await page.viewport(1280, 900);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const id of [parent.id, fork.id, other.id]) chatStore.dismissResponseError(id);
	conversationsStore.activeConversation = null;
	conversationsStore.conversations = [];
	document.querySelector('[data-pico-focus-target]')?.remove();
});

describe.runIf(IS_PICO_BUILD)('Pico chat history', () => {
	it('shows forks in recent order without indentation', async () => {
		const screen = render(SidebarNavigationHarness);

		await expect
			.poll(() => screen.container.querySelectorAll('[data-conversation-row]').length)
			.toBe(3);
		const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-conversation-row]')];

		expect(rows.map((row) => row.getAttribute('data-conversation-row'))).toEqual([
			fork.id,
			other.id,
			parent.id
		]);
		expect(rows.map((row) => getComputedStyle(row.firstElementChild!).paddingLeft)).toEqual([
			'0px',
			'0px',
			'0px'
		]);
		expect(fork.forkedFromConversationId).toBe(parent.id);
	});

	it('uses Rename in the chat menu and moves bulk selection out of routine row actions', async () => {
		const screen = render(SidebarNavigationHarness);

		await vi.waitFor(() => {
			const value = screen.container.querySelector<HTMLElement>(
				`[data-conversation-row="${fork.id}"]`
			);

			if (!value) throw new Error('Chat row not rendered');

			return value;
		});

		await screen.getByText(fork.name, { exact: true }).click({ button: 'right' });
		await expect.element(page.getByRole('menuitem', { exact: true, name: 'Rename' })).toBeVisible();
		await expect
			.element(page.getByRole('menuitem', { exact: true, name: 'Select' }))
			.not.toBeInTheDocument();
	});

	it('opens chat management from Data settings', async () => {
		const screen = render(SidebarNavigationHarness);

		await screen.getByRole('button', { name: /^Settings/ }).click();
		await page.getByRole('navigation').getByRole('button', { exact: true, name: 'Data' }).click();
		await page.getByRole('button', { exact: true, name: 'Manage chats' }).click();
		await expect
			.element(page.getByRole('checkbox', { exact: true, name: 'Select Original chat' }).first())
			.toBeVisible();
		expect(uiStore.chatManagementRequested).toBe(false);
	});
});

describe.runIf(IS_PICO_BUILD)('Pico response errors', () => {
	it('keeps failures with their originating conversation while switching chats', () => {
		chatStore.showErrorDialog({
			conversationId: parent.id,
			message: 'First failure',
			messageId: 'reply-a',
			type: ErrorDialogType.TIMEOUT
		});
		conversationsStore.activeConversation = other;
		chatStore.showErrorDialog({
			conversationId: other.id,
			message: 'Second failure',
			messageId: 'reply-b',
			type: ErrorDialogType.SERVER
		});
		expect(chatStore.getResponseError(parent.id)?.message).toBe('First failure');
		chatStore.dismissResponseError(other.id);
		expect(chatStore.getResponseError(other.id)).toBeNull();
		expect(chatStore.getResponseError(parent.id)?.messageId).toBe('reply-a');
	});

	it('reports an inline error without moving focus or opening a modal', async () => {
		const focusTarget = document.createElement('input');

		focusTarget.setAttribute('data-pico-focus-target', '');
		document.body.append(focusTarget);
		focusTarget.focus();
		const onRetry = vi.fn();
		const screen = render(PicoInlineError, {
			error: { message: 'Technical failure', type: ErrorDialogType.TIMEOUT },
			onDismiss: vi.fn(),
			onRetry
		});

		await expect.element(screen.getByRole('alert')).toBeVisible();
		expect(document.activeElement).toBe(focusTarget);
		await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
		await expect.element(screen.getByText('Technical failure', { exact: true })).not.toBeVisible();
		await screen.getByText('Technical details', { exact: true }).click();
		await expect.element(screen.getByText('Technical failure', { exact: true })).toBeVisible();
		await screen.getByRole('button', { exact: true, name: 'Try again' }).click();
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it('offers summarization for an oversized context rather than retrying the same request', async () => {
		const onSummarize = vi.fn();
		const onRetry = vi.fn();
		const screen = render(PicoInlineError, {
			error: {
				contextInfo: { n_ctx: 4096, n_prompt_tokens: 5000 },
				message: 'Context too large',
				type: ErrorDialogType.SERVER
			},
			onDismiss: vi.fn(),
			onRetry,
			onSummarize
		});

		await screen.getByRole('button', { name: 'Summarize earlier messages' }).click();
		expect(onSummarize).toHaveBeenCalledOnce();
		expect(onRetry).not.toHaveBeenCalled();
	});

	it('keeps retry unavailable while another request is running', async () => {
		const onRetry = vi.fn();
		const screen = render(PicoInlineError, {
			disabled: true,
			error: { message: 'Failure', type: ErrorDialogType.SERVER },
			onDismiss: vi.fn(),
			onRetry
		});

		await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
		expect(onRetry).not.toHaveBeenCalled();
	});
});
