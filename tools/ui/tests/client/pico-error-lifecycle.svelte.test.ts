import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { IS_PICO_BUILD } from '$lib/constants';
import {
	ChatStorageLocation,
	MessageRole,
	MessageType,
	ReasoningEffort,
	ServerRole,
	ToolSource
} from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { chatStorageStore } from '$lib/stores/chat-storage.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { DatabaseMessage, ExportedConversation } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: vi.fn(async () => {})
}));

function gate() {
	let resolve!: () => void;

	const promise = new Promise<void>((done) => (resolve = done));

	return { promise, resolve };
}

function makeSession(id: string): ExportedConversation {
	const root = `${id}-root`;
	const user = `${id}-user`;
	const old = `${id}-old`;
	const reply = `${id}-reply`;
	const message = (
		messageId: string,
		role: DatabaseMessage['role'],
		parent: string | null,
		children: string[],
		content: string,
		timestamp: number
	): DatabaseMessage => ({
		children,
		content,
		convId: id,
		id: messageId,
		parent,
		role,
		timestamp,
		type: MessageType.TEXT
	});

	return {
		conv: {
			currNode: reply,
			disabledToolCategories: [ToolSource.MCP],
			disabledTools: ['origin-disabled-tool'],
			id,
			lastModified: 0,
			name: id
		},
		messages: [
			message(root, MessageRole.SYSTEM, null, [user], '', 0),
			message(user, MessageRole.USER, root, [old, reply], 'Question', 1),
			message(old, MessageRole.ASSISTANT, user, [], 'Older complete response', 2),
			message(reply, MessageRole.ASSISTANT, user, [], 'Original partial response', 3)
		]
	};
}

let origin: ExportedConversation;
let other: ExportedConversation;
let previousConfig: SettingsConfigType;
let previousModel: string | null;

function display(session: ExportedConversation, leaf = `${session.conv.id}-reply`) {
	conversationsStore.activeConversation = { ...session.conv, currNode: leaf };
	chatStore.processing.setActiveConversation(session.conv.id);
	conversationsStore.activeMessages = session.messages
		.filter((message) => message.id.endsWith('-user') || message.id === leaf)
		.map((message) => ({ ...message }));
}

async function storedMessage(id: string): Promise<DatabaseMessage | undefined> {
	return (await DatabaseService.getConversationMessages(origin.conv.id)).find(
		(message) => message.id === id
	);
}

beforeEach(async () => {
	await DatabaseService.useStore(localChatStore);
	const prefix = `error-lifecycle-${crypto.randomUUID()}`;

	origin = makeSession(`${prefix}-a`);
	other = makeSession(`${prefix}-b`);
	other.conv.disabledToolCategories = [];
	other.conv.disabledTools = ['other-disabled-tool'];
	await DatabaseService.importConversations([origin, other]);
	conversationsStore.conversations = [{ ...origin.conv }, { ...other.conv }];
	display(origin);
	previousConfig = { ...settingsStore.config };
	previousModel = modelsStore.selectedModelName;
	settingsStore.config = {
		...settingsStore.config,
		preEncodeConversation: false,
		systemMessage: 'Origin instructions'
	};
	serverStore.role = ServerRole.MODEL;
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(agenticStore, 'runAgenticFlow').mockResolvedValue({ handled: false });
});

afterEach(async () => {
	await DatabaseService.useStore(localChatStore);
	vi.restoreAllMocks();
	for (const session of [origin, other]) {
		chatStore.cleanupStreaming(session.conv.id);
		chatStore.setChatReasoning(session.conv.id, false);
		chatStore.dismissResponseError(session.conv.id);
	}
	chatStore.errorDialogState = null;
	conversationsStore.activeConversation = null;
	chatStore.processing.setActiveConversation(null);
	conversationsStore.activeMessages = [];
	conversationsStore.conversations = [];
	settingsStore.config = previousConfig;
	modelsStore.selectedModelName = previousModel;
	await DatabaseService.bulkDeleteConversations([origin.conv.id, other.conv.id]);
});

describe('response lifecycle across navigation', () => {
	it('keeps server storage selected until an actual retry finishes its first asynchronous read', async () => {
		const server = new MockConversationsServer();
		const previousProps = serverStore.props;
		const entered = gate();
		const release = gate();

		let retry: Promise<void> | undefined;
		let retryConversationId: string | undefined;

		vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
		serverStore.props = { conversation_storage: true } as ApiLlamaCppServerProps;
		settingsStore.config.apiKey = 'retry-storage-key';
		try {
			await chatStorageStore.select(ChatStorageLocation.SERVER);
			const conversation = await DatabaseService.createConversation('Server retry');
			const root = await DatabaseService.createRootMessage(conversation.id);
			const user = await DatabaseService.createMessageBranch(
				{
					children: [],
					content: 'Question',
					convId: conversation.id,
					parent: root,
					role: MessageRole.USER,
					timestamp: 1,
					type: MessageType.TEXT
				},
				root
			);
			const response = await DatabaseService.createMessageBranch(
				{
					children: [],
					content: 'Original response',
					convId: conversation.id,
					model: 'origin-model',
					parent: user.id,
					role: MessageRole.ASSISTANT,
					timestamp: 2,
					type: MessageType.TEXT
				},
				user.id
			);

			retryConversationId = conversation.id;
			conversationsStore.activeConversation = (await DatabaseService.getConversation(
				conversation.id
			))!;
			conversationsStore.activeMessages = [user, response];
			let held = false;

			server.gate = async (request) => {
				if (
					!held &&
					request.method === 'GET' &&
					request.path.endsWith(`/${conversation.id}/items`)
				) {
					held = true;
					entered.resolve();
					await release.promise;
				}
			};
			const localWrite = vi.spyOn(localChatStore, 'createMessageBranch');
			const stream = vi.spyOn(chatStore, 'streamChatCompletion').mockImplementation(async () => {
				chatStore.cleanupStreaming(conversation.id);
			});

			retry = chatStore.regenerateMessageWithBranching(response.id);
			await entered.promise;
			expect(chatStore.isChatLoadingInternal(conversation.id)).toBe(true);
			const switching = chatStorageStore.select(ChatStorageLocation.BROWSER);

			await expect.poll(() => chatStorageStore.pending).toBe(ChatStorageLocation.BROWSER);
			expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);
			release.resolve();
			await Promise.all([retry, switching]);

			expect(stream).toHaveBeenCalledTimes(1);
			const [, assistant, , , model] = stream.mock.calls[0];

			expect(assistant.convId).toBe(conversation.id);
			expect(model).toBe('origin-model');
			expect(server.items.get(conversation.id)?.has(assistant.id)).toBe(true);
			expect(server.conversations.get(conversation.id)?.current_item_id).toBe(assistant.id);
			expect(localWrite).not.toHaveBeenCalled();
			expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
			expect(await DatabaseService.getConversation(conversation.id)).toBeUndefined();
		} finally {
			release.resolve();
			await retry;

			if (retryConversationId) chatStore.cleanupStreaming(retryConversationId);

			server.gate = null;
			await chatStorageStore.select(ChatStorageLocation.BROWSER);
			serverStore.props = previousProps;
		}
	});

	it('resolves the originating reasoning choice after its model finishes loading', async () => {
		const entered = gate();
		const release = gate();

		let loaded = false;

		origin.conv.reasoningEffort = ReasoningEffort.XHIGH;
		display(origin);
		serverStore.role = ServerRole.ROUTER;
		modelsStore.selectedModelName = 'origin-model';
		vi.spyOn(modelsStore.status, 'ensureLoaded').mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			loaded = true;
		});
		vi.spyOn(modelsStore.props, 'getModelProps').mockReturnValue({} as ApiLlamaCppServerProps);
		vi.spyOn(modelsStore.props, 'getReasoningEfforts').mockImplementation(() =>
			loaded ? [ReasoningEffort.XHIGH] : []
		);
		vi.mocked(agenticStore.runAgenticFlow).mockImplementation(async (params) => {
			expect(params.options).toMatchObject({
				enableThinking: true,
				model: 'origin-model',
				reasoningEffort: ReasoningEffort.XHIGH,
				systemMessage: 'Origin instructions'
			});
			expect(params.toolPolicy?.disabledTools).toEqual(['origin-disabled-tool']);

			return { handled: false };
		});
		vi.spyOn(ChatService, 'sendMessage').mockImplementation(async (_messages, options = {}) => {
			expect(options.model).toBe('origin-model');
			expect(options.reasoningEffort).toBe(ReasoningEffort.XHIGH);
			await options.onError?.(new Error('Stopped after model load'));
		});
		const reply = conversationsStore.activeMessages.at(-1)!;
		const completion = chatStore.streamChatCompletion(
			conversationsStore.activeMessages.slice(0, -1),
			reply
		);

		await entered.promise;
		display(other);
		modelsStore.selectedModelName = 'other-model';
		settingsStore.config.systemMessage = 'Changed after navigation';
		release.resolve();
		await completion;

		expect(conversationsStore.activeConversation?.currNode).toBe(other.conv.currNode);
		expect(chatStore.processing.activeConversationId).toBe(other.conv.id);
		expect((await DatabaseService.getConversation(other.conv.id))?.currNode).toBe(
			other.conv.currNode
		);
	});

	it.each(['read', 'branch'] as const)(
		'keeps a retry in its origin after switching chats during the %s await',
		async (boundary) => {
			const entered = gate();
			const release = gate();
			const originalRead = conversationsStore.getConversationMessages.bind(conversationsStore);
			const originalCreate = DatabaseService.createMessageBranch.bind(DatabaseService);
			const readSpy = vi.spyOn(conversationsStore, 'getConversationMessages');
			const createSpy = vi.spyOn(DatabaseService, 'createMessageBranch');

			if (boundary === 'read') {
				readSpy.mockImplementationOnce(async (id) => {
					const result = await originalRead(id);

					entered.resolve();
					await release.promise;

					return result;
				});
			} else {
				createSpy.mockImplementationOnce(async (...args) => {
					const result = await originalCreate(...args);

					entered.resolve();
					await release.promise;

					return result;
				});
			}

			const stream = vi.spyOn(chatStore, 'streamChatCompletion').mockImplementation(async () => {
				chatStore.cleanupStreaming(origin.conv.id);
			});
			const replyId = `${origin.conv.id}-reply`;
			const retry = chatStore.regenerateMessageWithBranching(replyId, 'origin-model');

			expect(chatStore.isChatLoadingInternal(origin.conv.id)).toBe(true);
			await chatStore.regenerateMessageWithBranching(replyId);
			await entered.promise;
			display(other);
			settingsStore.config.systemMessage = 'Changed after navigation';
			const visibleBefore = structuredClone($state.snapshot(conversationsStore.activeMessages));

			release.resolve();
			await retry;

			expect(createSpy).toHaveBeenCalledTimes(1);
			expect(stream).toHaveBeenCalledTimes(1);
			const [path, assistant, , , model, , snapshot] = stream.mock.calls[0];

			expect(path.at(-1)?.id).toBe(`${origin.conv.id}-user`);
			expect(assistant.convId).toBe(origin.conv.id);
			expect(model).toBe('origin-model');
			expect(snapshot?.options.systemMessage).toBe('Origin instructions');
			expect(snapshot?.toolPolicy.disabledTools).toEqual(['origin-disabled-tool']);
			expect(snapshot?.toolPolicy.disabledToolCategories).toEqual([ToolSource.MCP]);
			expect((await DatabaseService.getConversation(origin.conv.id))?.currNode).toBe(assistant.id);
			expect((await DatabaseService.getConversation(other.conv.id))?.currNode).toBe(
				other.conv.currNode
			);
			expect(conversationsStore.activeConversation?.id).toBe(other.conv.id);
			expect(conversationsStore.activeConversation?.currNode).toBe(other.conv.currNode);
			expect(conversationsStore.activeMessages).toEqual(visibleBefore);
			expect((await storedMessage(replyId))?.content).toBe('Original partial response');
			expect(chatStore.isChatLoadingInternal(origin.conv.id)).toBe(false);
		}
	);

	it.each(['version', 'chat'] as const)(
		'persists failed content and reasoning to the streaming response after changing %s',
		async (navigation) => {
			const reply = conversationsStore.activeMessages.at(-1)!;

			vi.spyOn(ChatService, 'sendMessage').mockImplementation(async (_messages, options = {}) => {
				options.onChunk?.('New partial response');
				options.onReasoningChunk?.('Partial reasoning');

				if (navigation === 'version') {
					display(origin, `${origin.conv.id}-old`);
					await DatabaseService.updateCurrentNode(origin.conv.id, `${origin.conv.id}-old`);
				} else {
					display(other);
				}

				const visibleBefore = structuredClone($state.snapshot(conversationsStore.activeMessages));

				await options.onError?.(new Error('Stream interrupted'));
				expect(conversationsStore.activeMessages).toEqual(visibleBefore);
			});

			chatStore.setChatLoading(origin.conv.id, true);
			await chatStore.streamChatCompletion(conversationsStore.activeMessages.slice(0, -1), reply);

			expect(await storedMessage(reply.id)).toMatchObject({
				content: 'New partial response',
				reasoningContent: 'Partial reasoning',
				toolCalls: ''
			});
			expect((await storedMessage(`${origin.conv.id}-old`))?.content).toBe(
				'Older complete response'
			);
			expect((await DatabaseService.getConversation(other.conv.id))?.currNode).toBe(
				other.conv.currNode
			);
			const error = IS_PICO_BUILD
				? chatStore.getResponseError(origin.conv.id)
				: chatStore.errorDialogState;

			expect(error?.conversationId).toBe(origin.conv.id);
			expect(error?.messageId).toBe(reply.id);

			if (IS_PICO_BUILD) expect(chatStore.errorDialogState).toBeNull();

			expect(chatStore.isChatLoadingInternal(origin.conv.id)).toBe(false);
		}
	);

	it('rechecks the visible message after a delayed partial write', async () => {
		const entered = gate();
		const release = gate();
		const reply = conversationsStore.activeMessages.at(-1)!;
		const originalUpdate = DatabaseService.updateMessage.bind(DatabaseService);

		vi.spyOn(DatabaseService, 'updateMessage').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			await originalUpdate(...args);
		});
		chatStore.setChatStreaming(origin.conv.id, 'Saved while navigating', reply.id);
		const save = chatStore.abortCurrentFlow(origin.conv.id);

		await entered.promise;
		display(other);
		const visibleBefore = structuredClone($state.snapshot(conversationsStore.activeMessages));

		release.resolve();
		await save;

		expect((await storedMessage(reply.id))?.content).toBe('Saved while navigating');
		expect(reply.content).toBe('Original partial response');
		expect(conversationsStore.activeMessages).toEqual(visibleBefore);
		expect(conversationsStore.activeConversation?.currNode).toBe(other.conv.currNode);
	});

	it('keeps a delayed completion cursor write out of the newly displayed chat', async () => {
		const entered = gate();
		const release = gate();
		const reply = conversationsStore.activeMessages.at(-1)!;
		const originalCursor = DatabaseService.updateCurrentNode.bind(DatabaseService);

		vi.spyOn(DatabaseService, 'updateCurrentNode').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			await originalCursor(...args);
		});
		vi.spyOn(ChatService, 'sendMessage').mockImplementation(async (_messages, options = {}) => {
			options.onChunk?.('Completed in origin');
			await options.onComplete?.('Completed in origin');
		});
		chatStore.setChatLoading(origin.conv.id, true);
		const completion = chatStore.streamChatCompletion(
			conversationsStore.activeMessages.slice(0, -1),
			reply
		);

		await entered.promise;
		display(other);
		const visibleBefore = structuredClone($state.snapshot(conversationsStore.activeMessages));

		release.resolve();
		await completion;

		expect((await storedMessage(reply.id))?.content).toBe('Completed in origin');
		expect((await DatabaseService.getConversation(origin.conv.id))?.currNode).toBe(reply.id);
		expect((await DatabaseService.getConversation(other.conv.id))?.currNode).toBe(
			other.conv.currNode
		);
		expect(conversationsStore.activeConversation?.currNode).toBe(other.conv.currNode);
		expect(conversationsStore.activeMessages).toEqual(visibleBefore);
	});
});
