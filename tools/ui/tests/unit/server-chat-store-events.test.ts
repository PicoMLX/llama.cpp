// Each window sends its own id with every Pico Server chat request, so the
// change notices its writes cause come back with its id as their origin.

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { HEADERS } from '$lib/constants';
import { MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ServerChatStore } from '$lib/services/server-chat-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let server: MockConversationsServer;

function message(convId: string, content: string): Omit<DatabaseMessage, 'id'> {
	return {
		children: [],
		content,
		convId,
		parent: null,
		role: MessageRole.USER,
		timestamp: Date.now(),
		toolCalls: '',
		type: MessageType.TEXT
	};
}

beforeEach(async () => {
	server = new MockConversationsServer();
	vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
	await DatabaseService.useStore(new ServerChatStore('test-key'));
});

afterEach(async () => {
	await DatabaseService.useStore(localChatStore);
	vi.restoreAllMocks();
});

describe('X-Pico-Client-Id', () => {
	it('is the same UUID on every request of the server store', async () => {
		const groupId = '00000000-0000-4000-8000-0000000000f1';
		const chat = await DatabaseService.createConversation('Chat');
		const rootId = await DatabaseService.createRootMessage(chat.id);
		const system = await DatabaseService.createSystemMessage(chat.id, 'Be brief', rootId);
		const user = await DatabaseService.createMessageBranch(message(chat.id, 'hi'), system.id);
		const reply = await DatabaseService.createMessageBranch(message(chat.id, 'hello'), user.id);

		await DatabaseService.updateMessage(user.id, { content: 'hi there' }, { ifVersion: 1 });
		await DatabaseService.updateConversation(chat.id, { name: 'Renamed' });
		await DatabaseService.updateCurrentNode(chat.id, reply.id);
		await DatabaseService.toggleConversationPin(chat.id);
		await DatabaseService.bulkToggleConversationPins([chat.id]);
		await DatabaseService.createGroup({ createdAt: 0, id: groupId, name: 'Work', updatedAt: 0 });
		await DatabaseService.updateGroup(groupId, { name: 'Home' });
		await DatabaseService.setConversationsGroup([chat.id], groupId);

		const fork = await DatabaseService.forkConversation(chat.id, user.id, {
			includeAttachments: false,
			name: 'Fork'
		});

		await DatabaseService.getAllConversations();
		await DatabaseService.getConversation(chat.id);
		await DatabaseService.getConversationMessages(chat.id);
		await DatabaseService.getAllGroups();
		await DatabaseService.getConversationsWithMessages([chat.id]);
		await DatabaseService.deleteMessage(reply.id);
		await DatabaseService.deleteMessageCascading(chat.id, user.id);
		await DatabaseService.deleteGroup(groupId);
		await DatabaseService.bulkDeleteConversations([fork.id]);
		await DatabaseService.deleteConversation(chat.id, { deleteWithForks: true });

		const ids = new Set(server.requests.map((r) => r.headers.get(HEADERS.X_PICO_CLIENT_ID_HEADER)));

		expect(server.requests.length).toBeGreaterThan(20);
		expect(ids.size).toBe(1);
		expect([...ids][0]).toMatch(UUID_V4);
	});

	it('stays the same for every server store this page makes', async () => {
		await DatabaseService.createConversation('First');
		await DatabaseService.useStore(new ServerChatStore('test-key'));
		await DatabaseService.createConversation('Second');

		const [first, second] = server.requests.map((r) =>
			r.headers.get(HEADERS.X_PICO_CLIENT_ID_HEADER)
		);

		expect(first).toMatch(UUID_V4);
		expect(second).toBe(first);
	});
});
