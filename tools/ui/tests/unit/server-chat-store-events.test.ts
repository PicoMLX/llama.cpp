// Each window sends its own id with every Pico Server chat request, so the
// change notices its writes cause come back with its id as their origin. The
// events stream hands over only other windows' notices, and reconnects with
// backoff after a drop.

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { API_CONVERSATIONS, HEADERS } from '$lib/constants';
import { ConversationEventType, MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ServerChatStore } from '$lib/services/server-chat-store';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { ApiConversationEvent } from '$lib/types/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OTHER_WINDOW = '00000000-0000-4000-8000-00000000beef';
const THEIR_CHAT = '00000000-0000-4000-8000-0000000000c1';

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
	vi.useRealTimers();
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

describe('ServerChatStore watchEvents', () => {
	it("hands over other windows' notices, skipping its own and keep-alives", async () => {
		const previousKey = settingsStore.config.apiKey;
		const stop = new AbortController();
		const events: ApiConversationEvent[] = [];
		const onReconnect = vi.fn();
		const store = new ServerChatStore('secret-key');

		// the stream goes out as the store's account, not the one in the settings
		settingsStore.config.apiKey = 'other-key';
		await DatabaseService.useStore(store);
		void store.watchEvents(stop.signal, (event) => events.push(event), onReconnect);
		await vi.waitFor(() => expect(server.eventStreams.size).toBe(1));

		await DatabaseService.createConversation('Mine');
		server.keepAlive();
		server.now = 7_000;
		await server.sendAs(OTHER_WINDOW, 'POST', API_CONVERSATIONS.CONVERSATIONS, {
			id: THEIR_CHAT,
			name: 'Theirs'
		});
		await vi.waitFor(() => expect(events).toHaveLength(1));
		stop.abort();
		settingsStore.config.apiKey = previousKey;

		// notices arrive in order, so this window's own one came first and was skipped
		expect(events).toEqual([
			{
				data: {
					conversation_id: THEIR_CHAT,
					last_modified_ms: 7_000,
					origin_client_id: OTHER_WINDOW,
					version: 1
				},
				event: ConversationEventType.CONVERSATION_CHANGED
			}
		]);
		expect(onReconnect).not.toHaveBeenCalled();

		const [stream, create] = server.requests;

		expect(stream.path).toBe(API_CONVERSATIONS.EVENTS);
		expect(stream.headers.get(HEADERS.AUTHORIZATION)).toBe('Bearer secret-key');
		expect(stream.headers.get(HEADERS.X_PICO_CLIENT_ID_HEADER)).toBe(
			create.headers.get(HEADERS.X_PICO_CLIENT_ID_HEADER)
		);
		await vi.waitFor(() => expect(server.eventStreams.size).toBe(0));
	});

	it('reconnects with backoff from 1 s doubling to 30 s, and reports each reconnect', async () => {
		vi.useFakeTimers();

		const stop = new AbortController();
		const onReconnect = vi.fn();
		const attempts: number[] = [];
		const gaps = () => attempts.slice(1).map((at, i) => at - attempts[i]);

		server.gate = (request) => {
			if (request.path === API_CONVERSATIONS.EVENTS) attempts.push(Date.now());
		};
		server.eventsDown = true;
		void new ServerChatStore('test-key').watchEvents(stop.signal, () => {}, onReconnect);
		await vi.advanceTimersByTimeAsync(0);

		for (let i = 0; i < 7; i++) await vi.advanceTimersToNextTimerAsync();

		expect(gaps()).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
		expect(onReconnect).not.toHaveBeenCalled();

		server.eventsDown = false;
		await vi.advanceTimersToNextTimerAsync();

		expect(server.eventStreams.size).toBe(1);
		expect(onReconnect).toHaveBeenCalledTimes(1);

		// a stream that was up starts over from 1 s once it drops
		server.dropEvents();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersToNextTimerAsync();

		expect(gaps().at(-1)).toBe(1000);
		expect(server.eventStreams.size).toBe(1);
		expect(onReconnect).toHaveBeenCalledTimes(2);

		stop.abort();
		await vi.advanceTimersByTimeAsync(5000);

		expect(server.eventStreams.size).toBe(0);
		expect(attempts).toHaveLength(10);
	});
});
