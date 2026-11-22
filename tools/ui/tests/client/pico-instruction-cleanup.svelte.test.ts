import { SYSTEM_MESSAGE_PLACEHOLDER } from '$lib/constants';
import { MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { chatStore, conversationsStore, draftMessagesStore } from '$lib/stores';
import type { ChatUploadedFile, DatabaseMessage, ExportedConversation } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	beforeNavigate: () => {},
	disableScrollHandling: () => {},
	goto: vi.fn(async () => {}),
	onNavigate: () => {}
}));

const createdIds = new Set<string>();

beforeEach(async () => {
	await DatabaseService.useStore(localChatStore);
});

afterEach(async () => {
	await DatabaseService.useStore(localChatStore);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	chatStore.clearPendingEditMessageId();
	draftMessagesStore.clearDraftMessage(undefined);
	for (const id of createdIds) {
		draftMessagesStore.clearDraftMessage(id);
		await DatabaseService.deleteConversation(id);
	}
	createdIds.clear();
	vi.restoreAllMocks();
});

describe('instruction cleanup with persisted conversations', () => {
	it('restores the new-chat text and files before deleting a cancelled placeholder conversation', async () => {
		const file = new File(['saved file content'], 'notes.txt', { type: 'text/plain' });
		const files: ChatUploadedFile[] = [
			{ file, id: 'draft-file', name: file.name, size: file.size, type: file.type }
		];

		draftMessagesStore.saveDraftMessage(undefined, 'Unsent question', files);

		await chatStore.addSystemPrompt({ files, message: 'Unsent question' });
		const id = conversationsStore.activeConversation!.id;

		createdIds.add(id);
		const messages = await DatabaseService.getConversationMessages(id);
		const placeholder = messages.find((entry) => entry.content === SYSTEM_MESSAGE_PLACEHOLDER)!;

		expect(messages).toHaveLength(2);
		expect(draftMessagesStore.getDraftMessage(undefined).message).toBe('');

		const deleted = await chatStore.removeSystemPromptPlaceholder(placeholder.id);

		expect(deleted).toBe(true);
		expect(await DatabaseService.getConversation(id)).toBeUndefined();
		const restored = draftMessagesStore.getDraftMessage(undefined);

		expect(restored.message).toBe('Unsent question');
		expect(restored.files).toHaveLength(1);
		expect(await restored.files[0].file.text()).toBe('saved file content');
		expect(restored.files[0].name).toBe('notes.txt');
		expect(draftMessagesStore.getDraftMessage(id)).toEqual({ files: [], message: '' });
	});

	it('splices a non-root system node through its actual parent without cutting previous history', async () => {
		const id = 'instruction-history-cleanup';

		createdIds.add(id);
		const node = (
			nodeId: string,
			role: MessageRole,
			parent: string | null,
			children: string[]
		): DatabaseMessage => ({
			children,
			content: nodeId,
			convId: id,
			id: nodeId,
			parent,
			role,
			timestamp: 123,
			type: MessageType.TEXT
		});
		const messages = [
			{ ...node('root', MessageRole.SYSTEM, null, ['question']), type: 'root' },
			node('question', MessageRole.USER, 'root', ['history-instruction']),
			node('history-instruction', MessageRole.SYSTEM, 'question', ['answer']),
			node('answer', MessageRole.ASSISTANT, 'history-instruction', [])
		] as DatabaseMessage[];

		await DatabaseService.importConversations([
			{
				conv: { currNode: 'answer', id, lastModified: 123, name: 'History' },
				messages
			} as ExportedConversation
		]);
		conversationsStore.activeConversation = (await DatabaseService.getConversation(id))!;
		conversationsStore.activeMessages = messages.slice(1);

		await chatStore.removeSystemPromptPlaceholder('history-instruction');

		const persisted = await DatabaseService.getConversationMessages(id);

		expect(persisted.find((entry) => entry.id === 'root')?.children).toEqual(['question']);
		expect(persisted.find((entry) => entry.id === 'question')?.children).toEqual(['answer']);
		expect(persisted.find((entry) => entry.id === 'answer')?.parent).toBe('question');
		expect(persisted.some((entry) => entry.id === 'history-instruction')).toBe(false);
		expect(conversationsStore.activeMessages.map((entry) => entry.id)).toEqual([
			'question',
			'answer'
		]);
	});
});
