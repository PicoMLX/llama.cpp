// The chat flows call DatabaseService the same way whichever store keeps the
// chats, so both stores must leave the same tree, branch and pins behind.

import { TEST_CHAT_STORES } from '../fixtures/chat-stores';
import { MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function message(
	convId: string,
	role: MessageRole,
	content: string,
	timestamp: number
): Omit<DatabaseMessage, 'id'> {
	return {
		children: [],
		content,
		convId,
		parent: null,
		role,
		timestamp,
		toolCalls: '',
		type: MessageType.TEXT
	};
}

/** The tree by content, so ids made by either store compare equal. */
async function tree(convId: string) {
	const messages = await DatabaseService.getConversationMessages(convId);
	const label = new Map(messages.map((m) => [m.id, m.type === 'root' ? 'root' : m.content]));

	return Object.fromEntries(
		messages.map((m) => [
			label.get(m.id),
			{
				children: m.children.map((id: string) => label.get(id)),
				parent: m.parent ? label.get(m.parent) : null
			}
		])
	);
}

describe.each(TEST_CHAT_STORES)('chat store parity in $name', (store) => {
	beforeEach(async () => {
		await store.use();
	});

	afterEach(async () => {
		const conversations = await DatabaseService.getAllConversations();

		await DatabaseService.bulkDeleteConversations(conversations.map((c) => c.id));
		await DatabaseService.useStore(localChatStore);
	});

	it('adds a system prompt above the first message the way addSystemPrompt does', async () => {
		const conversation = await DatabaseService.createConversation('Chat');
		const rootId = await DatabaseService.createRootMessage(conversation.id);
		const user = await DatabaseService.createMessageBranch(
			message(conversation.id, MessageRole.USER, 'hello', 1),
			rootId
		);

		await DatabaseService.createMessageBranch(
			message(conversation.id, MessageRole.ASSISTANT, 'hi', 2),
			user.id
		);

		const system = await DatabaseService.createSystemMessage(conversation.id, 'Be brief', rootId);

		await DatabaseService.updateMessage(user.id, { parent: system.id });
		await DatabaseService.updateMessage(system.id, { children: [user.id] });
		await DatabaseService.updateMessage(rootId, { children: [system.id] });

		expect(await tree(conversation.id)).toEqual({
			'Be brief': { children: ['hello'], parent: 'root' },
			hello: { children: ['hi'], parent: 'Be brief' },
			hi: { children: [], parent: 'hello' },
			root: { children: ['Be brief'], parent: null }
		});
	});

	it('deletes a branch and keeps its siblings', async () => {
		const conversation = await DatabaseService.createConversation('Chat');
		const rootId = await DatabaseService.createRootMessage(conversation.id);
		const user = await DatabaseService.createMessageBranch(
			message(conversation.id, MessageRole.USER, 'hello', 1),
			rootId
		);
		const first = await DatabaseService.createMessageBranch(
			message(conversation.id, MessageRole.ASSISTANT, 'first', 2),
			user.id
		);

		await DatabaseService.createMessageBranch(
			message(conversation.id, MessageRole.USER, 'follow-up', 3),
			first.id
		);

		const second = await DatabaseService.createMessageBranch(
			message(conversation.id, MessageRole.ASSISTANT, 'second', 4),
			user.id
		);

		expect((await DatabaseService.getConversation(conversation.id))?.currNode).toBe(second.id);

		await DatabaseService.deleteMessageCascading(conversation.id, first.id);

		expect(await tree(conversation.id)).toEqual({
			hello: { children: ['second'], parent: 'root' },
			root: { children: ['hello'], parent: null },
			second: { children: [], parent: 'hello' }
		});
	});

	it('toggles pins and unpins a chat that joins a group', async () => {
		const groupId = store.id('work');
		const chat = await DatabaseService.createConversation('Chat');

		await DatabaseService.createGroup({ createdAt: 0, id: groupId, name: 'Work', updatedAt: 0 });

		expect(await DatabaseService.toggleConversationPin(chat.id)).toBe(true);

		await DatabaseService.setConversationsGroup([chat.id], groupId);

		expect(await DatabaseService.getConversation(chat.id)).toMatchObject({
			groupId,
			pinned: false
		});

		await DatabaseService.deleteGroup(groupId);
	});

	it('keeps forks of a deleted chat unless they go with it', async () => {
		const source = await DatabaseService.createConversation('Source');
		const rootId = await DatabaseService.createRootMessage(source.id);
		const kept = await DatabaseService.forkConversation(source.id, rootId, {
			includeAttachments: false,
			name: 'Kept'
		});

		await DatabaseService.deleteConversation(source.id);

		expect(await DatabaseService.getConversation(kept.id)).toMatchObject({ name: 'Kept' });
		expect(
			(await DatabaseService.getConversation(kept.id))?.forkedFromConversationId
		).toBeUndefined();

		const keptRoot = (await DatabaseService.getConversationMessages(kept.id))[0];
		const fork = await DatabaseService.forkConversation(kept.id, keptRoot.id, {
			includeAttachments: false,
			name: 'Fork'
		});

		await DatabaseService.deleteConversation(kept.id, { deleteWithForks: true });

		expect(await DatabaseService.getConversation(fork.id)).toBeUndefined();
	});
});
