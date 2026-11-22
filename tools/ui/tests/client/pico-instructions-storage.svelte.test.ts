import '../../src/app.css';
import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import PicoChatScreenHarness from './components/PicoChatScreenHarness.svelte';
import {
	API_CONVERSATIONS,
	CHAT_STORAGE_LOCALSTORAGE_KEY,
	IS_PICO_BUILD,
	SYSTEM_MESSAGE_PLACEHOLDER
} from '$lib/constants';
import { ChatStorageLocation, MessageRole, MessageType, ServerRole } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { chatStorageStore } from '$lib/stores/chat-storage.svelte';
import { chatSyncStore } from '$lib/stores/chat-sync.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { groupsStore } from '$lib/stores/groups.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
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

const apiKey = 'pico-instructions-storage-key';
const model = 'pico-instructions-storage-model';
const otherWindow = '00000000-0000-4000-8000-00000000beef';

let server: MockConversationsServer;
let previousConfig: SettingsConfigType;
let writeStatuses: number[];

beforeEach(async () => {
	await page.viewport(1280, 900);
	server = new MockConversationsServer();
	writeStatuses = [];
	const passThrough = vi.mocked(globalThis.fetch).getMockImplementation();

	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(raw, window.location.origin).pathname;

		if (!path.startsWith('/v1/conversation')) return passThrough!(input, init);

		const response = await server.fetch(input, init);

		if (init?.method === 'POST' && path.includes('/items/')) writeStatuses.push(response.status);

		return response;
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
	chatStore.clearEditMode();
	chatStore.clearPendingEditMessageId();
	chatStore.errorDialogState = null;
	await chatStorageStore.select(ChatStorageLocation.BROWSER);
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	conversationsStore.clearActiveConversation();
	modelsStore.models = [{ capabilities: [], id: model, model, name: model }];
	modelsStore.selectedModelId = model;
	modelsStore.selectedModelName = model;
	modelsStore.loading = false;
	modelsStore.updating = false;
	vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
	vi.spyOn(modelsStore.props, 'getModelProps').mockReturnValue(serverStore.props);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await chatStorageStore.select(ChatStorageLocation.SERVER);
	await vi.waitFor(() => expect(server.eventStreams.size).toBe(1));
});

afterEach(async () => {
	const id = conversationsStore.activeConversation?.id;

	if (id) {
		chatActivityStore.localEnded(id);
		chatStore.cleanupStreaming(id);
	}

	chatStore.clearEditMode();
	chatStore.clearPendingEditMessageId();
	chatSyncStore.stop();
	await chatStorageStore.select(ChatStorageLocation.BROWSER);
	server.dropEvents();
	chatStore.errorDialogState = null;
	chatStore.processing.setActiveConversation(null);
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	groupsStore.groups = [];
	modelsStore.models = [];
	modelsStore.clearSelection();
	settingsStore.config = previousConfig;
	serverStore.clear();
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	vi.restoreAllMocks();
});

async function openInstructions(content = 'Original rules') {
	const conversation = await DatabaseService.createConversation('Instructions with history');
	const rootId = await DatabaseService.createRootMessage(conversation.id);
	const instructions = await DatabaseService.createSystemMessage(conversation.id, content, rootId);
	const user = await DatabaseService.createMessageBranch(
		{
			children: [],
			content: 'Keep this question',
			convId: conversation.id,
			parent: instructions.id,
			role: MessageRole.USER,
			timestamp: Date.now(),
			type: MessageType.TEXT
		},
		instructions.id
	);

	await conversationsStore.loadConversations();
	expect(await conversationsStore.loadConversation(conversation.id)).toBe(true);
	render(PicoChatScreenHarness);
	chatStore.pendingEditMessageId = instructions.id;
	const dialog = page.getByRole('dialog', { exact: true, name: 'Chat instructions' });
	const textbox = dialog.getByRole('textbox', { exact: true, name: 'Chat instructions' });

	await expect.element(dialog).toBeVisible();
	await expect.element(textbox).toHaveValue(content === SYSTEM_MESSAGE_PLACEHOLDER ? '' : content);

	return { conversation, dialog, instructions, rootId, textbox, user };
}

const listReads = () =>
	server.requests.filter(
		(request) => request.method === 'GET' && request.path === API_CONVERSATIONS.CONVERSATIONS
	).length;

async function editElsewhere(conversationId: string, messageId: string) {
	const before = listReads();
	const response = await server.sendAs(
		otherWindow,
		'POST',
		`${API_CONVERSATIONS.CONVERSATIONS}/${conversationId}/items/${messageId}`,
		{ content: [{ text: 'Newer rules from another window', type: 'input_text' }] }
	);

	expect(response.status).toBe(200);
	await vi.waitFor(() => expect(listReads()).toBeGreaterThan(before));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe.runIf(IS_PICO_BUILD)('Instructions in Pico Server storage', () => {
	it.each(['version capture failure', 'account change'] as const)(
		'refuses a blank write after a %s and preserves the draft',
		async (cause) => {
			if (cause === 'version capture failure') {
				vi.spyOn(DatabaseService, 'versionForEdit').mockRejectedValue(
					new Error('Version could not be read')
				);
			}

			const { dialog, textbox } = await openInstructions();

			await textbox.fill('');

			if (cause === 'account change') settingsStore.config.apiKey = 'another-account-key';

			const before = server.requests.length;

			await dialog.getByRole('button', { exact: true, name: 'Save instructions' }).click();
			const errorDialog = page.getByRole('alertdialog', { exact: true, name: 'Server Error' });

			await expect.element(errorDialog).toBeVisible();
			expect(server.requests.slice(before).some((request) => request.method !== 'GET')).toBe(false);
			await errorDialog.getByRole('button', { exact: true, name: 'Close' }).click();
			await expect.element(dialog).toBeVisible();
			await expect.element(textbox).toHaveValue('');
			settingsStore.config.apiKey = apiKey;
		}
	);

	it('leaves newer remote instructions intact when cancelling a stale placeholder', async () => {
		const { conversation, dialog, instructions, textbox } = await openInstructions(
			SYSTEM_MESSAGE_PLACEHOLDER
		);

		await textbox.fill('Discard this local draft');
		await editElsewhere(conversation.id, instructions.id);
		await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
		await vi.waitFor(() => expect(writeStatuses).toEqual([409]));
		const errorDialog = page.getByRole('alertdialog', { exact: true, name: 'Server Error' });

		await expect.element(errorDialog).toBeVisible();
		await errorDialog.getByRole('button', { exact: true, name: 'Close' }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await vi.waitFor(() =>
			expect(
				conversationsStore.activeMessages.find((message) => message.id === instructions.id)?.content
			).toBe('Newer rules from another window')
		);
		const persisted = await DatabaseService.getConversationMessages(conversation.id);

		expect(persisted.find((message) => message.id === instructions.id)?.content).toBe(
			'Newer rules from another window'
		);
		expect(server.requests.some((request) => request.method === 'DELETE')).toBe(false);
	});

	it('keeps the unsaved draft while editing and reloads remote instructions after Cancel', async () => {
		const { conversation, dialog, instructions, textbox } = await openInstructions();
		const reads = () =>
			server.requests.filter(
				(request) =>
					request.method === 'GET' &&
					request.path.startsWith(`${API_CONVERSATIONS.CONVERSATIONS}/${conversation.id}`)
			).length;
		const before = reads();

		await textbox.fill('My unsaved instructions');
		await editElsewhere(conversation.id, instructions.id);
		expect(reads()).toBe(before);
		await expect.element(textbox).toHaveValue('My unsaved instructions');
		expect(
			conversationsStore.activeMessages.find((message) => message.id === instructions.id)?.content
		).toBe('Original rules');
		await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await vi.waitFor(() =>
			expect(
				conversationsStore.activeMessages.find((message) => message.id === instructions.id)?.content
			).toBe('Newer rules from another window')
		);
		expect(reads()).toBeGreaterThan(before);
	});

	it('rejects a stale blank Save with the edit-start version and keeps its draft open', async () => {
		const { conversation, dialog, instructions, textbox } = await openInstructions();

		await textbox.fill('');
		await editElsewhere(conversation.id, instructions.id);
		await dialog.getByRole('button', { exact: true, name: 'Save instructions' }).click();
		await vi.waitFor(() => expect(writeStatuses).toEqual([409]));
		const write = server.requests.findLast(
			(request) => request.method === 'POST' && request.path.endsWith(`/items/${instructions.id}`)
		);

		expect(write?.body).toEqual({
			content: [{ text: '', type: 'input_text' }],
			if_version: instructions.version
		});
		const errorDialog = page.getByRole('alertdialog', { exact: true, name: 'Server Error' });

		await expect.element(errorDialog).toBeVisible();
		await errorDialog.getByRole('button', { exact: true, name: 'Close' }).click();
		await expect.element(dialog).toBeVisible();
		await expect.element(textbox).toHaveValue('');
		const persisted = await DatabaseService.getConversationMessages(conversation.id);

		expect(persisted.find((message) => message.id === instructions.id)?.content).toBe(
			'Newer rules from another window'
		);
		expect(server.requests.some((request) => request.method === 'DELETE')).toBe(false);
		await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
	});

	it('clears instructions with one versioned update while preserving the message path', async () => {
		const { conversation, dialog, instructions, rootId, textbox, user } = await openInstructions();
		const before = server.requests.length;

		await textbox.fill('');
		await dialog.getByRole('button', { exact: true, name: 'Save instructions' }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		const writes = server.requests.slice(before).filter((request) => request.method !== 'GET');

		expect(
			writes.map((request) => ({ body: request.body, method: request.method, path: request.path }))
		).toEqual([
			{
				body: { content: [{ text: '', type: 'input_text' }], if_version: instructions.version },
				method: 'POST',
				path: `${API_CONVERSATIONS.CONVERSATIONS}/${conversation.id}/items/${instructions.id}`
			}
		]);
		expect(writeStatuses).toEqual([200]);
		const persisted = await DatabaseService.getConversationMessages(conversation.id);

		expect(persisted.find((message) => message.id === rootId)?.children).toEqual([instructions.id]);
		expect(persisted.find((message) => message.id === instructions.id)).toMatchObject({
			children: [user.id],
			content: '',
			parent: rootId
		});
		expect(persisted.find((message) => message.id === user.id)?.parent).toBe(instructions.id);
		expect((await DatabaseService.getConversation(conversation.id))?.currNode).toBe(user.id);
		expect(conversationsStore.activeMessages.map((message) => message.id)).toEqual([
			instructions.id,
			user.id
		]);
		expect(await ChatService.normalizeMessagesForApi(conversationsStore.activeMessages)).toEqual([
			expect.objectContaining({ content: 'Keep this question', role: MessageRole.USER })
		]);
	});
});
