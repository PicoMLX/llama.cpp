import PicoChatScreenHarness from './components/PicoChatScreenHarness.svelte';
import { IS_PICO_BUILD } from '$lib/constants';
import { ErrorDialogType, MessageRole, MessageType, ServerRole } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import {
	chatStore,
	conversationsStore,
	modelsStore,
	serverStore,
	settingsStore
} from '$lib/stores';
import type { ApiLlamaCppServerProps, DatabaseConversation } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	afterNavigate: () => {},
	beforeNavigate: () => {},
	disableScrollHandling: () => {},
	onNavigate: () => {}
}));

const model = 'error-screen-model';
const createdIds = new Set<string>();

let conversation: DatabaseConversation;
let previousConfig: SettingsConfigType;

beforeEach(async () => {
	await page.viewport(1280, 900);
	conversation = await DatabaseService.createConversation('Error screen');
	createdIds.add(conversation.id);
	conversationsStore.conversations = [conversation];
	await conversationsStore.loadConversation(conversation.id);
	serverStore.role = ServerRole.MODEL;
	serverStore.loading = false;
	serverStore.error = null;
	serverStore.props = {
		default_generation_settings: { n_ctx: 4096 },
		modalities: { audio: false, vision: false }
	} as ApiLlamaCppServerProps;
	modelsStore.models = [{ capabilities: [], id: model, model, name: model }];
	modelsStore.selectedModelId = model;
	modelsStore.selectedModelName = model;
	modelsStore.loading = false;
	modelsStore.updating = false;
	previousConfig = { ...settingsStore.config };
	settingsStore.config = {
		...settingsStore.config,
		preEncodeConversation: false,
		systemMessage: '',
		titleGenerationUseLLM: false
	};
	vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
	vi.spyOn(modelsStore.props, 'getModelProps').mockReturnValue(serverStore.props);
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const id of createdIds) {
		chatStore.cleanupStreaming(id);
		chatStore.dismissResponseError(id);
		conversationsStore.consumeLastLoadedMessages(id);
	}
	chatStore.errorDialogState = null;
	chatStore.processing.setActiveConversation(null);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	conversationsStore.conversations = [];
	modelsStore.models = [];
	modelsStore.clearSelection();
	serverStore.clear();
	settingsStore.config = previousConfig;
	await DatabaseService.bulkDeleteConversations([...createdIds]);
	createdIds.clear();
});

describe.runIf(IS_PICO_BUILD)('Pico error recovery on the chat screen', () => {
	it('refreshes response versions after retrying an inline failure', async () => {
		const root = await DatabaseService.createRootMessage(conversation.id);
		const prompt = await DatabaseService.createMessageBranch(
			{
				children: [],
				content: 'A question',
				convId: conversation.id,
				role: MessageRole.USER,
				timestamp: 1,
				type: MessageType.TEXT
			},
			root
		);
		const failed = await DatabaseService.createMessageBranch(
			{
				children: [],
				content: 'Original partial response',
				convId: conversation.id,
				model,
				role: MessageRole.ASSISTANT,
				timestamp: 2,
				type: MessageType.TEXT
			},
			prompt.id
		);

		await conversationsStore.loadConversation(conversation.id);
		chatStore.showErrorDialog({
			conversationId: conversation.id,
			message: 'Stream failed',
			messageId: failed.id,
			type: ErrorDialogType.SERVER
		});
		vi.spyOn(chatStore, 'streamChatCompletion').mockImplementation(async (_messages, assistant) => {
			await DatabaseService.updateMessage(assistant.id, { content: 'Retry completed' });
			conversationsStore.updateMessageAtIndex(conversationsStore.findMessageIndex(assistant.id), {
				content: 'Retry completed'
			});
			chatStore.cleanupStreaming(conversation.id);
		});
		const screen = render(PicoChatScreenHarness);

		await screen.getByRole('button', { exact: true, name: 'Try again' }).click();
		await expect.element(screen.getByText('Retry completed', { exact: true })).toBeVisible();
		await expect
			.element(screen.getByRole('navigation', { exact: true, name: 'Message version 2 of 2' }))
			.toBeVisible();
		const persisted = await DatabaseService.getConversationMessages(conversation.id);
		const versions = persisted.filter(
			(message) => message.parent === prompt.id && message.role === MessageRole.ASSISTANT
		);

		expect(versions.map((message) => message.content)).toEqual([
			'Original partial response',
			'Retry completed'
		]);
		await screen.getByRole('button', { exact: true, name: 'Previous version' }).click();
		await expect
			.element(screen.getByText('Original partial response', { exact: true }))
			.toBeVisible();
	});

	it('shows and dismisses a first-message save failure while the transcript is empty', async () => {
		const screen = render(PicoChatScreenHarness);

		vi.spyOn(chatStore, 'addMessage').mockRejectedValueOnce(
			new Error('Message could not be saved')
		);
		await screen.getByRole('textbox').fill('First question');
		await screen.getByRole('button', { exact: true, name: 'Send' }).click();
		await expect.element(screen.getByRole('alert')).toBeVisible();
		expect(conversationsStore.activeMessages).toEqual([]);
		expect(chatStore.getResponseError(conversation.id)?.messageId).toBeUndefined();
		expect(screen.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
		await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
		await screen.getByText('Technical details', { exact: true }).click();
		await expect
			.element(screen.getByText('Message could not be saved', { exact: true }))
			.toBeVisible();
		const other = await DatabaseService.createConversation('Another empty chat');

		createdIds.add(other.id);
		await conversationsStore.loadConversation(other.id);
		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
		expect(chatStore.getResponseError(conversation.id)).not.toBeNull();
		await conversationsStore.loadConversation(conversation.id);
		await expect.element(screen.getByRole('alert')).toBeVisible();
		expect(screen.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
		await screen.getByRole('button', { exact: true, name: 'Dismiss' }).click();
		await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
		expect(chatStore.getResponseError(conversation.id)).toBeNull();
	});
});
