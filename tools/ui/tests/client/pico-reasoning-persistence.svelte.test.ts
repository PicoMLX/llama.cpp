import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { chatStore, conversationsStore } from '$lib/stores';
import type { DatabaseMessage, ExportedConversation } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let session: ExportedConversation;

beforeEach(async () => {
	await DatabaseService.useStore(localChatStore);
	const id = `reasoning-persistence-${crypto.randomUUID()}`;
	const user: DatabaseMessage = {
		children: [`${id}-reply`],
		content: 'Question',
		convId: id,
		id: `${id}-user`,
		parent: null,
		role: MessageRole.USER,
		timestamp: 1,
		type: MessageType.TEXT
	};
	const reply: DatabaseMessage = {
		...user,
		children: [],
		content: 'Original answer',
		id: `${id}-reply`,
		parent: user.id,
		reasoningContent: 'Original thought',
		role: MessageRole.ASSISTANT,
		timings: {
			predicted_ms: 100,
			predicted_n: 1,
			prompt_ms: 1000,
			prompt_n: 10,
			reasoning_ms: 2000
		}
	};

	session = {
		conv: { currNode: reply.id, id, lastModified: 1, name: 'Reasoning persistence' },
		messages: [user, reply]
	};
	await DatabaseService.importConversations([session]);
	conversationsStore.activeConversation = { ...session.conv };
	conversationsStore.activeMessages = structuredClone(session.messages);
	chatStore.processing.setActiveConversation(id);
	vi.spyOn(ChatService, 'cancelServerStream').mockResolvedValue();
});

afterEach(async () => {
	chatStore.cleanupStreaming(session.conv.id);
	chatStore.dismissResponseError(session.conv.id);
	chatStore.processing.setActiveConversation(null);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	await DatabaseService.bulkDeleteConversations([session.conv.id]);
	vi.restoreAllMocks();
});

describe.runIf(IS_PICO_BUILD)('continued reasoning persistence', () => {
	it.each(['complete', 'stop'] as const)(
		'keeps the replay baseline until partial content is saved on %s',
		async (ending) => {
			const replyId = session.messages[1].id;
			const storedReply = async () =>
				(await DatabaseService.getConversationMessages(session.conv.id)).find(
					(item) => item.id === replyId
				)!;

			vi.spyOn(ChatService, 'sendMessage').mockImplementation(async (_messages, options = {}) => {
				options.onReasoningChunk?.(' continued thought');

				if (ending === 'stop') {
					const currentTimings = {
						predicted_ms: 3000,
						predicted_n: 30,
						prompt_ms: 2000,
						prompt_n: 20
					};

					options.onTimings?.(currentTimings);
					await chatStore.stopGenerationForChat(session.conv.id);
					options.onTimings?.({ ...currentTimings, reasoning_ms: 3000 });

					return;
				}

				options.onTimings?.({ reasoning_ms: 3000 });
				expect(conversationsStore.activeMessages[1].timings?.reasoning_ms).toBe(5000);
				expect((await storedReply()).timings?.reasoning_ms).toBe(2000);
				options.onChunk?.(' continued answer');
				await options.onComplete?.(' continued answer', ' continued thought', {
					reasoning_ms: 3000
				});
			});

			await chatStore.continueAssistantMessage(replyId);
			const saved = await storedReply();

			expect(saved.reasoningContent).toBe('Original thought continued thought');
			expect(saved.timings?.reasoning_ms).toBe(5000);

			if (ending === 'stop') {
				expect(saved.timings).toMatchObject({
					predicted_ms: 3000,
					predicted_n: 30,
					prompt_ms: 2000,
					prompt_n: 20
				});
			}

			expect(saved.content).toBe(
				ending === 'complete' ? 'Original answer continued answer' : 'Original answer'
			);
		}
	);
});
