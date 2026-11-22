import '../../src/app.css';
import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import PicoChatScreenHarness from './components/PicoChatScreenHarness.svelte';
import SettingsChat from '$lib/components/app/settings/SettingsChat/SettingsChat.svelte';
import { API_CONVERSATIONS, CHAT_STORAGE_LOCALSTORAGE_KEY, IS_PICO_BUILD } from '$lib/constants';
import { ChatStorageLocation, ErrorDialogType, ServerRole } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import {
	chatStorageStore,
	chatStore,
	conversationsStore,
	modelsStore,
	serverStore,
	settingsStore
} from '$lib/stores';
import { chatSyncStore } from '$lib/stores/chat-sync.svelte';
import type { ApiLlamaCppServerProps } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	afterNavigate: () => {},
	beforeNavigate: () => {},
	disableScrollHandling: () => {},
	goto: vi.fn(async () => {}),
	onNavigate: () => {}
}));

const apiKey = 'pico-storage-integration-key';
const model = 'pico-storage-integration-model';
const busyId = 'pico-storage-switch-busy';
const failureMessage = 'Saved chats could not be loaded';

let server: MockConversationsServer;
let failList = false;
let previousConfig: SettingsConfigType;

const errorConversationIds = new Set<string>();

beforeEach(async () => {
	await page.viewport(1280, 900);
	server = new MockConversationsServer();
	failList = false;
	const passThrough = vi.mocked(globalThis.fetch).getMockImplementation();

	vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(raw, window.location.origin).pathname;

		if (path.startsWith('/v1/conversation')) {
			if (
				failList &&
				path === API_CONVERSATIONS.CONVERSATIONS &&
				(!init?.method || init.method === 'GET')
			) {
				return Promise.resolve(
					new Response(JSON.stringify({ error: { message: failureMessage } }), {
						headers: { 'Content-Type': 'application/json' },
						status: 500
					})
				);
			}

			return server.fetch(input, init);
		}

		return passThrough!(input, init);
	});
	previousConfig = { ...settingsStore.config };
	settingsStore.config = { ...settingsStore.config, apiKey, preEncodeConversation: false };
	serverStore.role = ServerRole.MODEL;
	serverStore.loading = false;
	serverStore.error = null;
	serverStore.props = {
		conversation_storage: true,
		default_generation_settings: { n_ctx: 4096 },
		modalities: { audio: false, vision: false }
	} as ApiLlamaCppServerProps;
	await chatStorageStore.select(ChatStorageLocation.BROWSER);
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	chatStore.errorDialogState = null;
	modelsStore.models = [{ capabilities: [], id: model, model, name: model }];
	modelsStore.selectedModelId = model;
	modelsStore.selectedModelName = model;
	modelsStore.loading = false;
	modelsStore.updating = false;
	vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
	vi.spyOn(modelsStore.props, 'getModelProps').mockReturnValue(serverStore.props);
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
	failList = false;
	chatStore.setChatLoading(busyId, false);
	chatSyncStore.stop();
	await chatStorageStore.select(ChatStorageLocation.BROWSER);
	server.dropEvents();
	for (const id of errorConversationIds) chatStore.dismissResponseError(id);
	await DatabaseService.bulkDeleteConversations([...errorConversationIds]);
	errorConversationIds.clear();
	chatStore.errorDialogState = null;
	chatStore.processing.setActiveConversation(null);
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	modelsStore.models = [];
	modelsStore.clearSelection();
	settingsStore.config = previousConfig;
	serverStore.clear();
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	vi.restoreAllMocks();
});

async function expectGlobalStorageError() {
	const dialog = page.getByRole('alertdialog', { exact: true, name: 'Server Error' });

	await expect.element(dialog).toBeVisible();
	await expect.element(dialog.getByText(failureMessage, { exact: true })).toBeVisible();
	expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
	expect(document.querySelectorAll('.chat-messages [role="alert"]')).toHaveLength(0);
	expect(chatStore.errorDialogState?.conversationId).toBeUndefined();
	await expect
		.element(dialog.getByRole('button', { exact: true, name: 'Try again' }))
		.not.toBeInTheDocument();
	await dialog.getByRole('button', { exact: true, name: 'Close' }).click();
	await expect.element(dialog).not.toBeInTheDocument();
}

describe.runIf(IS_PICO_BUILD)('Pico server storage with the simplified interface', () => {
	it.each(['saved choice', 'storage switch'] as const)(
		'shows a failed server list load on the new-chat screen after a %s',
		async (entry) => {
			if (entry === 'saved choice') {
				await chatStorageStore.select(ChatStorageLocation.SERVER);
				await DatabaseService.useStore(localChatStore);
				chatStorageStore.location = ChatStorageLocation.BROWSER;
				await chatStorageStore.initialize();
			}

			render(PicoChatScreenHarness);
			failList = true;

			if (entry === 'saved choice') {
				await expect(conversationsStore.loadConversations()).rejects.toThrow(failureMessage);
			} else {
				await chatStorageStore.select(ChatStorageLocation.SERVER);
			}

			expect(conversationsStore.activeConversation).toBeNull();
			await expectGlobalStorageError();
		}
	);

	it('shows one global storage error without turning it into an active-chat response failure', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);
		const conversation = await DatabaseService.createConversation('Server chat');

		errorConversationIds.add(conversation.id);
		await conversationsStore.loadConversation(conversation.id);
		render(PicoChatScreenHarness);
		failList = true;
		await expect(conversationsStore.loadConversations()).rejects.toThrow(failureMessage);
		expect(chatStore.getResponseError(conversation.id)).toBeNull();
		await expectGlobalStorageError();
	});

	it('keeps a scoped response failure inline without also opening a global dialog', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);
		const conversation = await DatabaseService.createConversation('Response failure');

		errorConversationIds.add(conversation.id);
		await conversationsStore.loadConversation(conversation.id);
		const screen = render(PicoChatScreenHarness);

		chatStore.showErrorDialog({
			conversationId: conversation.id,
			message: 'Response was interrupted',
			type: ErrorDialogType.SERVER
		});
		await expect.element(screen.getByRole('alert')).toBeVisible();
		await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
		expect(screen.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
		await screen.getByRole('button', { exact: true, name: 'Dismiss' }).click();
		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
	});

	it('dismisses a storage failure without clearing the active response failure', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);
		const conversation = await DatabaseService.createConversation('Two failures');

		errorConversationIds.add(conversation.id);
		await conversationsStore.loadConversation(conversation.id);
		const screen = render(PicoChatScreenHarness);

		chatStore.showErrorDialog({
			conversationId: conversation.id,
			message: 'Keep this response failure',
			type: ErrorDialogType.SERVER
		});
		failList = true;
		await expect(conversationsStore.loadConversations()).rejects.toThrow(failureMessage);
		const dialog = page.getByRole('alertdialog', { exact: true, name: 'Server Error' });

		await expect.element(dialog).toBeVisible();
		await dialog.getByRole('button', { exact: true, name: 'Close' }).click();
		expect(chatStore.errorDialogState).toBeNull();
		expect(chatStore.getResponseError(conversation.id)?.message).toBe('Keep this response failure');
		await expect.element(screen.getByRole('alert')).toBeVisible();
		await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
	});

	it('keeps storage selection and server import restrictions in Settings Data', async () => {
		const screen = render(SettingsChat);

		await screen.getByRole('button', { exact: true, name: 'Data' }).click();
		const browserChoice = screen.getByRole('radio', { exact: true, name: 'This browser' });
		const serverChoice = screen.getByRole('radio', { exact: true, name: 'Pico Server' });

		await expect.element(serverChoice).toBeVisible();
		serverStore.props = { ...serverStore.props!, conversation_storage: false };
		await expect.element(serverChoice).not.toBeInTheDocument();
		serverStore.props = { ...serverStore.props!, conversation_storage: true };
		settingsStore.config.apiKey = '';
		await expect.element(serverChoice).not.toBeInTheDocument();
		settingsStore.config.apiKey = apiKey;
		await expect.element(serverChoice).toBeVisible();
		chatStore.setChatLoading(busyId, true);
		await serverChoice.click();
		await expect.poll(() => chatStorageStore.pending).toBe(ChatStorageLocation.SERVER);
		await expect.element(browserChoice).toBeDisabled();
		await expect.element(serverChoice).toBeDisabled();
		await expect
			.element(screen.getByText('Waiting for replies and saves to finish...'))
			.toBeVisible();
		chatStore.setChatLoading(busyId, false);
		await expect.poll(() => chatStorageStore.location).toBe(ChatStorageLocation.SERVER);
		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Import conversations' }))
			.toBeDisabled();
		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Export conversations' }))
			.toBeEnabled();
		await expect
			.element(
				screen.getByText("Import isn't available while chats are stored on Pico Server", {
					exact: false
				})
			)
			.toBeVisible();
		await screen.getByRole('button', { exact: true, name: 'Advanced' }).click();
		await screen.getByText('Settings backup', { exact: true }).click();
		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Import settings' }))
			.toBeVisible();
		await expect
			.element(screen.getByText('Store chats in', { exact: true }))
			.not.toBeInTheDocument();
		await expect.element(serverChoice).not.toBeInTheDocument();
	});
});

it.runIf(!IS_PICO_BUILD)('keeps generic conversation errors in the existing dialog', async () => {
	const conversation = await DatabaseService.createConversation('Generic error');

	errorConversationIds.add(conversation.id);
	await conversationsStore.loadConversation(conversation.id);
	render(PicoChatScreenHarness);
	chatStore.showErrorDialog({
		conversationId: conversation.id,
		message: 'Generic response failed',
		type: ErrorDialogType.SERVER
	});
	await expect
		.element(page.getByRole('alertdialog', { exact: true, name: 'Server Error' }))
		.toBeVisible();
	await expect.element(page.getByText('Generic response failed', { exact: true })).toBeVisible();
});
