// The server store keeps DatabaseService's contract over Pico Server's
// conversations API: snake_case on the wire, client-made ids, writes to a chat
// in call order, settings patched per key, and the tree kept by parents only.

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ServerChatStore } from '$lib/services/server-chat-store';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let server: MockConversationsServer;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

function message(
	convId: string,
	overrides: Partial<DatabaseMessage> = {}
): Omit<DatabaseMessage, 'id'> {
	return {
		children: [],
		content: '',
		convId,
		parent: null,
		role: MessageRole.USER,
		timestamp: Date.now(),
		toolCalls: '',
		type: MessageType.TEXT,
		...overrides
	};
}

/** A chat with a root and one user message under it. */
async function chatWithMessage(text = 'hello') {
	const conversation = await DatabaseService.createConversation('Chat');
	const rootId = await DatabaseService.createRootMessage(conversation.id);
	const user = await DatabaseService.createMessageBranch(
		message(conversation.id, { content: text }),
		rootId
	);

	return { conversation, rootId, user };
}

function deferred() {
	let resolve!: () => void;

	const promise = new Promise<void>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

beforeEach(async () => {
	server = new MockConversationsServer();
	onError = vi.fn<(error: unknown) => void>();
	vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
	await DatabaseService.useStore(new ServerChatStore('test-key'), onError);
});

afterEach(async () => {
	server.gate = null;
	await DatabaseService.useStore(localChatStore);
	vi.restoreAllMocks();
});

describe('ServerChatStore records', () => {
	it('creates a chat under a client-made UUID and maps it to camelCase', async () => {
		server.now = 5_000;

		const created = await DatabaseService.createConversation('Plan', {
			cwd: '/work',
			reasoningEffort: 'high' as never
		});

		expect(created.id).toMatch(UUID_V4);
		expect(server.requests[0].body).toEqual({
			id: created.id,
			name: 'Plan',
			settings: { cwd: '/work', reasoningEffort: 'high' }
		});
		expect(await DatabaseService.getConversation(created.id)).toEqual({
			currNode: '',
			cwd: '/work',
			id: created.id,
			lastModified: 5_000,
			name: 'Plan',
			pinned: false,
			reasoningEffort: 'high',
			version: 1
		});
	});

	it('reads a missing chat as undefined and its messages as empty', async () => {
		const id = '11111111-1111-4111-8111-111111111111';

		expect(await DatabaseService.getConversation(id)).toBeUndefined();
		expect(await DatabaseService.getConversationMessages(id)).toEqual([]);
		expect(onError).not.toHaveBeenCalled();
	});

	it('maps message fields both ways and keeps tool calls as given', async () => {
		const { conversation, user } = await chatWithMessage();
		const toolCalls = [{ function: { arguments: '{}', name: 'search' }, id: 'call-1' }];
		const assistant = await DatabaseService.createMessageBranch(
			message(conversation.id, {
				completionId: 'cmpl-1',
				content: 'answer',
				model: 'qwen',
				reasoningContent: 'thinking',
				role: MessageRole.ASSISTANT,
				timings: { predicted_n: 3 } as never,
				toolCalls: JSON.stringify(toolCalls)
			}),
			user.id
		);
		const sent = server.requests.at(-1)!.body!;

		expect(sent).toMatchObject({
			current_item_id: assistant.id,
			items: [
				{
					completion_id: 'cmpl-1',
					content: [{ annotations: [], text: 'answer', type: 'output_text' }],
					id: assistant.id,
					message_type: 'text',
					model: 'qwen',
					parent_id: user.id,
					reasoning_content: 'thinking',
					role: 'assistant',
					timings: { predicted_n: 3 },
					tool_calls: toolCalls
				}
			]
		});
		expect((sent.items as Record<string, unknown>[])[0]).not.toHaveProperty('children_ids');

		const read = (await DatabaseService.getConversationMessages(conversation.id)).find(
			(m) => m.id === assistant.id
		)!;

		expect(read).toMatchObject({
			children: [],
			completionId: 'cmpl-1',
			content: 'answer',
			convId: conversation.id,
			model: 'qwen',
			parent: user.id,
			reasoningContent: 'thinking',
			role: 'assistant',
			version: 1
		});
		expect(JSON.parse(read.toolCalls!)).toEqual(toolCalls);
	});
});

describe('ServerChatStore writes', () => {
	it('keeps writes to a chat in call order when nobody awaits them', async () => {
		const { conversation, user } = await chatWithMessage();
		const assistant = await DatabaseService.createMessageBranch(
			message(conversation.id, { role: MessageRole.ASSISTANT }),
			user.id
		);
		const first = deferred();

		let held = false;

		server.gate = async (request) => {
			if (!held && request.method === 'POST' && request.path.endsWith(assistant.id)) {
				held = true;
				await first.promise;
			}
		};
		server.requests = [];

		void DatabaseService.updateMessage(assistant.id, { model: 'first' });
		void DatabaseService.updateMessage(assistant.id, { timings: { predicted_n: 1 } as never });
		const last = DatabaseService.updateMessage(assistant.id, { content: 'final' });

		await new Promise((resolve) => setTimeout(resolve, 20));

		const sentWhileHeld = server.requests.length;

		first.resolve();
		await last;

		// the later writes wait for the held one instead of overtaking it
		expect(sentWhileHeld).toBe(0);

		expect(server.requests.map((r) => Object.keys(r.body!))).toEqual([
			['model'],
			['timings'],
			['content']
		]);
		expect(server.items.get(conversation.id)!.get(assistant.id)).toMatchObject({
			content: [{ text: 'final' }],
			model: 'first',
			timings: { predicted_n: 1 },
			version: 4
		});
	});

	it('reads a chat after the writes sent before the read', async () => {
		const { conversation, user } = await chatWithMessage();
		const write = deferred();

		server.gate = async (request) => {
			if (request.method === 'POST') await write.promise;
		};
		server.requests = [];

		void DatabaseService.updateMessage(user.id, { content: 'edited' });

		const read = DatabaseService.getConversationMessages(conversation.id);

		await new Promise((resolve) => setTimeout(resolve, 20));

		const sentWhileHeld = server.requests.length;

		write.resolve();

		expect(sentWhileHeld).toBe(0);
		expect((await read)[1].content).toBe('edited');
		expect(server.log()).toEqual([
			`POST /v1/conversations/${conversation.id}/items/${user.id}`,
			`GET /v1/conversations/${conversation.id}/items`
		]);
	});

	it('patches settings per key and sends undefined as null', async () => {
		const conversation = await DatabaseService.createConversation('Chat', {
			cwd: '/work',
			disabledTools: ['a']
		});

		await DatabaseService.updateConversation(conversation.id, { cwd: undefined });

		expect(server.requests.at(-1)!.body).toEqual({ settings: { cwd: null } });
		expect(server.conversations.get(conversation.id)!.settings).toEqual({ disabledTools: ['a'] });
		expect(await DatabaseService.getConversation(conversation.id)).not.toHaveProperty('cwd');
	});

	it('sends no request for fields only this browser keeps', async () => {
		const conversation = await DatabaseService.createConversation('Chat');

		server.requests = [];
		await DatabaseService.updateConversation(conversation.id, { lastModified: 99 });

		expect(server.requests).toEqual([]);
	});

	it('sends an explicit pinned value', async () => {
		const a = await DatabaseService.createConversation('A');
		const b = await DatabaseService.createConversation('B', { pinned: true });

		expect(await DatabaseService.toggleConversationPin(a.id)).toBe(true);
		expect(server.requests.at(-1)!.body).toEqual({ pinned: true });

		const states = await DatabaseService.bulkToggleConversationPins([a.id, b.id]);

		expect(states).toEqual(
			new Map([
				[a.id, false],
				[b.id, false]
			])
		);
		expect(server.requests.slice(-2).map((r) => r.body)).toEqual([
			{ pinned: false },
			{ pinned: false }
		]);
	});

	it('unpins chats that join a group, one update per chat', async () => {
		const group = await DatabaseService.createGroup({
			createdAt: 0,
			id: '22222222-2222-4222-8222-222222222222',
			name: 'Work',
			updatedAt: 0
		});
		const a = await DatabaseService.createConversation('A', { pinned: true });
		const b = await DatabaseService.createConversation('B');

		server.requests = [];
		await DatabaseService.setConversationsGroup([a.id, b.id], group.id);

		expect(server.log()).toEqual([
			`POST /v1/conversations/${a.id}`,
			`POST /v1/conversations/${b.id}`
		]);
		expect(server.requests.map((r) => r.body)).toEqual([
			{ group_id: group.id, pinned: false },
			{ group_id: group.id, pinned: false }
		]);

		await DatabaseService.setConversationsGroup([a.id], null);

		expect(server.requests.at(-1)!.body).toEqual({ group_id: null });
	});

	it('points the chat at a new branch in the same request', async () => {
		const { conversation, user } = await chatWithMessage();

		expect(server.requests.at(-1)!.body).toMatchObject({ current_item_id: user.id });
		expect((await DatabaseService.getConversation(conversation.id))?.currNode).toBe(user.id);
	});

	it('turns a parent change into a move and never sends children', async () => {
		const { conversation, rootId, user } = await chatWithMessage();
		const system = await DatabaseService.createSystemMessage(conversation.id, 'Be brief', rootId);

		server.requests = [];

		// the three rewiring updates addSystemPrompt makes
		await DatabaseService.updateMessage(user.id, { parent: system.id });
		await DatabaseService.updateMessage(system.id, { children: [user.id] });
		await DatabaseService.updateMessage(rootId, { children: [system.id] });

		expect(server.requests.map((r) => r.body)).toEqual([{ parent_id: system.id }]);

		const byId = new Map(
			(await DatabaseService.getConversationMessages(conversation.id)).map((m) => [m.id, m])
		);

		expect(byId.get(rootId)?.children).toEqual([system.id]);
		expect(byId.get(system.id)?.children).toEqual([user.id]);
		expect(byId.get(user.id)?.parent).toBe(system.id);
	});

	it('deletes one message, or a message with its branch', async () => {
		const { conversation, rootId, user } = await chatWithMessage();
		const reply = await DatabaseService.createMessageBranch(
			message(conversation.id, { role: MessageRole.ASSISTANT }),
			user.id
		);

		await DatabaseService.deleteMessage(reply.id);

		expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE' });
		expect(server.requests.at(-1)!.search.get('cascade')).toBeNull();

		const again = await DatabaseService.createMessageBranch(
			message(conversation.id, { role: MessageRole.ASSISTANT }),
			user.id
		);
		const deleted = await DatabaseService.deleteMessageCascading(conversation.id, user.id);

		expect(server.requests.at(-1)!.search.get('cascade')).toBe('true');
		expect(new Set(deleted)).toEqual(new Set([user.id, again.id]));
		expect(
			(await DatabaseService.getConversationMessages(conversation.id)).map((m) => m.id)
		).toEqual([rootId]);
		expect((await DatabaseService.getConversation(conversation.id))?.currNode).toBe(rootId);
	});

	it('forks through fork_from in one request, with the group and cwd the chat had', async () => {
		const group = await DatabaseService.createGroup({
			createdAt: 0,
			id: '33333333-3333-4333-8333-333333333333',
			name: 'Work',
			updatedAt: 0
		});
		const source = await DatabaseService.createConversation('Source', {
			cwd: '/work',
			groupId: group.id
		});
		const rootId = await DatabaseService.createRootMessage(source.id);
		const user = await DatabaseService.createMessageBranch(
			message(source.id, { content: 'hello' }),
			rootId
		);

		server.requests = [];

		const fork = await DatabaseService.forkConversation(source.id, user.id, {
			includeAttachments: false,
			name: 'Fork'
		});

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].body).toEqual({
			fork_from: { conversation_id: source.id, include_attachments: false, item_id: user.id },
			group_id: group.id,
			id: fork.id,
			name: 'Fork',
			settings: { cwd: '/work' }
		});
		expect(fork).toMatchObject({
			cwd: '/work',
			forkedFromConversationId: source.id,
			groupId: group.id
		});

		const copied = await DatabaseService.getConversationMessages(fork.id);

		expect(copied.map((m) => m.content)).toEqual(['', 'hello']);
		expect(fork.currNode).toBe(copied[1].id);
	});

	it('deletes a chat with or without its forks in one request each', async () => {
		const source = await DatabaseService.createConversation('Source');
		const rootId = await DatabaseService.createRootMessage(source.id);
		const fork = await DatabaseService.forkConversation(source.id, rootId, {
			includeAttachments: false,
			name: 'Fork'
		});

		server.requests = [];
		await DatabaseService.deleteConversation(source.id, { deleteWithForks: true });

		expect(server.log()).toEqual([`DELETE /v1/conversations/${source.id}`]);
		expect(server.requests[0].search.get('forks')).toBe('delete');
		expect(server.conversations.has(fork.id)).toBe(false);

		const a = await DatabaseService.createConversation('A');
		const b = await DatabaseService.createConversation('B');

		server.requests = [];
		await DatabaseService.bulkDeleteConversations([a.id, b.id]);

		expect(server.requests.map((r) => `${r.method} ${r.path}?${r.search}`)).toEqual([
			`DELETE /v1/conversations/${a.id}?forks=keep`,
			`DELETE /v1/conversations/${b.id}?forks=keep`
		]);
	});

	it('keeps groups on the server and their chats when a group goes', async () => {
		server.now = 10;

		const group = await DatabaseService.createGroup({
			createdAt: 0,
			id: '44444444-4444-4444-8444-444444444444',
			name: 'Work',
			updatedAt: 0
		});

		expect(group).toEqual({
			createdAt: 10,
			id: '44444444-4444-4444-8444-444444444444',
			name: 'Work',
			updatedAt: 10,
			version: 1
		});

		server.now = 20;
		await DatabaseService.updateGroup(group.id, { name: 'Renamed', updatedAt: 5 });

		expect(server.requests.at(-1)!.body).toEqual({ name: 'Renamed' });
		expect(await DatabaseService.getAllGroups()).toEqual([
			{ ...group, name: 'Renamed', updatedAt: 20, version: 2 }
		]);

		const chat = await DatabaseService.createConversation('In group', { groupId: group.id });

		await DatabaseService.deleteGroup(group.id);

		expect(await DatabaseService.getAllGroups()).toEqual([]);
		expect((await DatabaseService.getConversation(chat.id))?.groupId).toBeUndefined();
	});

	it('exports the chats asked for with their messages', async () => {
		const { conversation, rootId, user } = await chatWithMessage();
		const exported = await DatabaseService.getConversationsWithMessages([
			conversation.id,
			'55555555-5555-4555-8555-555555555555'
		]);

		expect([...exported.keys()]).toEqual([conversation.id]);
		expect(exported.get(conversation.id)!.messages.map((m) => m.id)).toEqual([rootId, user.id]);
	});
});

describe('ServerChatStore errors', () => {
	it('makes import unavailable', async () => {
		await expect(DatabaseService.importConversations([])).rejects.toThrow(
			"Import isn't available while chats are stored on Pico Server"
		);
		expect(server.requests).toEqual([]);
	});

	it('surfaces a failed write and never writes it elsewhere', async () => {
		const missing = '66666666-6666-4666-8666-666666666666';

		await expect(DatabaseService.updateConversation(missing, { name: 'x' })).rejects.toMatchObject({
			status: 404
		});
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('sends the API key with every request', async () => {
		await DatabaseService.useStore(new ServerChatStore('secret-key'), onError);
		await DatabaseService.getAllConversations();

		expect(server.requests[0].headers.get('Authorization')).toBe('Bearer secret-key');
	});

	it('keeps the API key it was made for when the setting changes', async () => {
		const previous = settingsStore.config.apiKey;

		await DatabaseService.useStore(new ServerChatStore('key-a'), onError);

		const chat = await DatabaseService.createConversation('Chat');

		settingsStore.config.apiKey = 'key-b';

		try {
			await DatabaseService.updateConversation(chat.id, { pinned: true });
			await DatabaseService.getConversation(chat.id);
			await DatabaseService.deleteConversation(chat.id);
		} finally {
			settingsStore.config.apiKey = previous;
		}

		expect(server.requests.map((r) => r.headers.get('Authorization'))).toEqual([
			'Bearer key-a',
			'Bearer key-a',
			'Bearer key-a',
			'Bearer key-a'
		]);
	});
});
