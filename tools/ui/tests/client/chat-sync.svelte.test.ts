// While chats are on Pico Server, a window follows what other windows change:
// their changes reload the list and the open chat, a chat they delete leaves
// the screen, and group changes reload the groups. Its own changes, and an
// open chat it is replying or editing in, are left alone. After a reconnect
// it reads everything again, and the stream closes when chats leave Pico
// Server.

import { vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { goto } from '$app/navigation';
import { API_CONVERSATIONS, CHAT_STORAGE_LOCALSTORAGE_KEY, HEADERS, ROUTES } from '$lib/constants';
import { ChatStorageLocation, MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { chatStorageStore } from '$lib/stores/chat-storage.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { groupsStore } from '$lib/stores/groups.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const KEY_A = 'account-a-secret';
const KEY_B = 'account-b-secret';
const OTHER_WINDOW = '00000000-0000-4000-8000-00000000beef';
const THEIR_CHAT = '00000000-0000-4000-8000-0000000000c1';
const THEIR_GROUP = '00000000-0000-4000-8000-0000000000f1';
const THEIR_REPLY = '00000000-0000-4000-8000-0000000000e1';
const THEIR_BRANCH = '00000000-0000-4000-8000-0000000000e2';

let server: MockConversationsServer;
/** Times of the messages other windows add, each later than any this window made. */
let clock = 0;

function setProps(conversationStorage: boolean) {
	serverStore.props = {
		conversation_storage: conversationStorage,
		default_generation_settings: { n_ctx: 2048 }
	} as unknown as ApiLlamaCppServerProps;
}

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

/** Opens a chat this window made: a root and one user message under it. */
async function openChat(name = 'Chat') {
	const chat = await DatabaseService.createConversation(name);
	const rootId = await DatabaseService.createRootMessage(chat.id);
	const user = await DatabaseService.createMessageBranch(message(chat.id, 'hi'), rootId);

	await conversationsStore.loadConversations();
	expect(await conversationsStore.loadConversation(chat.id)).toBe(true);

	return { chat, rootId, user };
}

const shownText = () => conversationsStore.activeMessages.map((m) => m.content);
const listName = (id: string) => conversationsStore.conversations.find((c) => c.id === id)?.name;

/** How many times the server was asked for the list, or for one chat or its items. */
function reads(convId?: string): number {
	const chatPath = `${API_CONVERSATIONS.CONVERSATIONS}/${convId}`;

	return server.requests.filter(
		(r) =>
			r.method === 'GET' &&
			(convId ? r.path.startsWith(chatPath) : r.path === API_CONVERSATIONS.CONVERSATIONS)
	).length;
}

function eventConnections(): number {
	return server.requests.filter((r) => r.path === API_CONVERSATIONS.EVENTS).length;
}

/** Lets the reload that just landed finish its last steps, or waits `ms`. */
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function renameElsewhere(convId: string, name: string) {
	return server.sendAs(OTHER_WINDOW, 'POST', `${API_CONVERSATIONS.CONVERSATIONS}/${convId}`, {
		name
	});
}

function editElsewhere(convId: string, itemId: string, text: string) {
	return server.sendAs(
		OTHER_WINDOW,
		'POST',
		`${API_CONVERSATIONS.CONVERSATIONS}/${convId}/items/${itemId}`,
		{ content: [{ text, type: 'input_text' }] }
	);
}

function replyElsewhere(convId: string, id: string, parentId: string, text: string, current = id) {
	return server.sendAs(OTHER_WINDOW, 'POST', `${API_CONVERSATIONS.CONVERSATIONS}/${convId}/items`, {
		current_item_id: current,
		items: [
			{
				content: [{ annotations: [], text, type: 'output_text' }],
				id,
				message_type: 'text',
				parent_id: parentId,
				role: 'assistant',
				timestamp_ms: (clock += 1000)
			}
		]
	});
}

function createChatElsewhere(id: string, name: string) {
	return server.sendAs(OTHER_WINDOW, 'POST', API_CONVERSATIONS.CONVERSATIONS, { id, name });
}

beforeEach(async () => {
	server = new MockConversationsServer();
	clock = Date.now() + 60_000;

	const passThrough = vi.mocked(globalThis.fetch).getMockImplementation();

	vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

		return url.includes('/v1/conversation') ? server.fetch(input, init) : passThrough!(input, init);
	});
	vi.mocked(goto).mockClear();
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	settingsStore.config.apiKey = KEY_A;
	setProps(true);
	await chatStorageStore.select(ChatStorageLocation.SERVER);
	await vi.waitFor(() => expect(server.eventStreams.size).toBe(1));
});

afterEach(async () => {
	chatActivityStore.localEnded(conversationsStore.activeConversation?.id ?? '');
	chatStore.clearEditMode();
	settingsStore.config.apiKey = KEY_A;
	setProps(true);
	await chatStorageStore.select(ChatStorageLocation.BROWSER);
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	groupsStore.groups = [];
	settingsStore.config.apiKey = '';
	serverStore.props = null;
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	vi.restoreAllMocks();
});

describe("another window's changes", () => {
	it("skips the notices of this window's own writes", async () => {
		const { chat, user } = await openChat();
		const itemReads = reads(chat.id);

		// had this notice counted, the open chat would show the new text
		await DatabaseService.updateMessage(user.id, { content: 'saved here' });
		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));
		await settle();

		expect(reads(chat.id)).toBe(itemReads);
		expect(shownText()).toEqual(['hi']);
	});

	it('reloads the list once for a burst, and the open chat with it', async () => {
		const { chat, user } = await openChat();
		const listReads = reads();

		// well inside the debounce, yet each in a task of its own
		await renameElsewhere(chat.id, 'Renamed elsewhere');
		await settle(50);
		await editElsewhere(chat.id, user.id, 'edited elsewhere');
		await settle(50);
		await replyElsewhere(chat.id, THEIR_REPLY, user.id, 'their reply');

		await vi.waitFor(() => expect(shownText()).toEqual(['edited elsewhere', 'their reply']));
		expect(listName(chat.id)).toBe('Renamed elsewhere');
		expect(conversationsStore.activeConversation?.name).toBe('Renamed elsewhere');
		expect(reads() - listReads).toBe(1);
	});

	it("keeps this window's branch when another window moves to a new one", async () => {
		const { chat, rootId, user } = await openChat();

		await replyElsewhere(chat.id, THEIR_REPLY, user.id, 'on this branch');
		await vi.waitFor(() => expect(shownText()).toEqual(['hi', 'on this branch']));

		// a new first message under the root, which the other window then shows
		await server.sendAs(
			OTHER_WINDOW,
			'POST',
			`${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}/items`,
			{
				current_item_id: THEIR_BRANCH,
				items: [
					{
						content: [{ text: 'another question', type: 'input_text' }],
						id: THEIR_BRANCH,
						message_type: 'text',
						parent_id: rootId,
						role: 'user',
						timestamp_ms: (clock += 1000)
					}
				]
			}
		);
		await renameElsewhere(chat.id, 'Marker');
		await vi.waitFor(() => expect(conversationsStore.activeConversation?.name).toBe('Marker'));

		expect(shownText()).toEqual(['hi', 'on this branch']);
		expect(server.conversations.get(chat.id)?.current_item_id).toBe(THEIR_BRANCH);
	});

	it('does not reload the open chat while this window replies or edits in it', async () => {
		const { chat, user } = await openChat();
		const itemReads = reads(chat.id);

		chatActivityStore.markLocal(chat.id);
		await editElsewhere(chat.id, user.id, 'while replying');
		await renameElsewhere(chat.id, 'Renamed while replying');
		await vi.waitFor(() => expect(listName(chat.id)).toBe('Renamed while replying'));
		await settle();
		chatActivityStore.localEnded(chat.id);

		chatStore.setEditModeActive(() => {});
		await editElsewhere(chat.id, user.id, 'while editing');
		await renameElsewhere(chat.id, 'Renamed while editing');
		await vi.waitFor(() => expect(listName(chat.id)).toBe('Renamed while editing'));
		await settle();
		chatStore.clearEditMode();

		expect(reads(chat.id)).toBe(itemReads);
		expect(shownText()).toEqual(['hi']);

		await editElsewhere(chat.id, user.id, 'once idle');
		await vi.waitFor(() => expect(shownText()).toEqual(['once idle']));
	});

	it('removes a chat deleted elsewhere, and leaves it when it is open', async () => {
		await createChatElsewhere(THEIR_CHAT, 'Theirs');

		const { chat } = await openChat();

		expect(listName(THEIR_CHAT)).toBe('Theirs');

		await server.sendAs(OTHER_WINDOW, 'DELETE', `${API_CONVERSATIONS.CONVERSATIONS}/${THEIR_CHAT}`);
		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBeUndefined());

		expect(conversationsStore.activeConversation?.id).toBe(chat.id);
		expect(goto).not.toHaveBeenCalled();

		await server.sendAs(OTHER_WINDOW, 'DELETE', `${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}`);
		await vi.waitFor(() => expect(conversationsStore.activeConversation).toBeNull());

		expect(listName(chat.id)).toBeUndefined();
		expect(goto).toHaveBeenCalledWith(ROUTES.START);
	});

	it('reloads the groups, and the list with them, on group notices', async () => {
		const { chat } = await openChat();
		const groupPath = `${API_CONVERSATIONS.GROUPS}/${THEIR_GROUP}`;

		await server.sendAs(OTHER_WINDOW, 'POST', API_CONVERSATIONS.GROUPS, {
			id: THEIR_GROUP,
			name: 'Work'
		});
		await vi.waitFor(() => expect(groupsStore.get(THEIR_GROUP)?.name).toBe('Work'));

		await server.sendAs(OTHER_WINDOW, 'POST', groupPath, { name: 'Home' });
		await server.sendAs(OTHER_WINDOW, 'POST', `${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}`, {
			group_id: THEIR_GROUP
		});
		await vi.waitFor(() => expect(groupsStore.get(THEIR_GROUP)?.name).toBe('Home'));
		await vi.waitFor(() =>
			expect(conversationsStore.conversations.find((c) => c.id === chat.id)?.groupId).toBe(
				THEIR_GROUP
			)
		);

		// deleting a group takes its chats out of it, and sends only the group notice
		await server.sendAs(OTHER_WINDOW, 'DELETE', groupPath);
		await vi.waitFor(() => {
			expect(groupsStore.get(THEIR_GROUP)).toBeUndefined();
			expect(
				conversationsStore.conversations.find((c) => c.id === chat.id)?.groupId
			).toBeUndefined();
		});
	});
});

describe('the notices stream', () => {
	it('reads the list, the groups and the open chat again after a reconnect', async () => {
		const { chat, user } = await openChat();

		server.dropEvents();
		// nobody hears these: the stream is down
		await editElsewhere(chat.id, user.id, 'while disconnected');
		await renameElsewhere(chat.id, 'Renamed while disconnected');
		await server.sendAs(OTHER_WINDOW, 'POST', API_CONVERSATIONS.GROUPS, {
			id: THEIR_GROUP,
			name: 'Work'
		});

		await vi.waitFor(() => expect(server.eventStreams.size).toBe(1), { timeout: 3000 });
		await vi.waitFor(() => expect(shownText()).toEqual(['while disconnected']));

		expect(listName(chat.id)).toBe('Renamed while disconnected');
		expect(groupsStore.get(THEIR_GROUP)?.name).toBe('Work');
		expect(eventConnections()).toBe(2);
	});

	it('closes when chats go back to this browser', async () => {
		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		expect(server.eventStreams.size).toBe(0);
		expect(eventConnections()).toBe(1);
	});

	it('closes when the API key changes or Pico Server stops offering storage', async () => {
		// another account has made no choice, so its chats are in this browser
		settingsStore.config.apiKey = KEY_B;
		await chatStorageStore.sync();

		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
		expect(server.eventStreams.size).toBe(0);

		settingsStore.config.apiKey = KEY_A;
		await chatStorageStore.sync();
		await vi.waitFor(() => expect(server.eventStreams.size).toBe(1));

		const reopened = server.requests.filter((r) => r.path === API_CONVERSATIONS.EVENTS).at(-1)!;

		expect(reopened.headers.get(HEADERS.AUTHORIZATION)).toBe(`${HEADERS.BEARER}${KEY_A}`);

		setProps(false);
		await chatStorageStore.sync();

		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
		expect(server.eventStreams.size).toBe(0);
	});
});
