// While chats are on Pico Server, a window follows what other windows change:
// their changes reload the list and the open chat, a chat they delete leaves
// the screen, and group changes reload the groups. Its own changes, and an
// open chat it is replying or editing in, are left alone, also when they land
// while a reload reads. A failed reload is tried again a few times. After a
// reconnect, or a first stream that opens late, it reads everything again,
// and the stream closes when chats leave Pico Server.
// A store's first read of the chats and each stream's reloads run one after another.

import { vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { goto } from '$app/navigation';
import {
	API_CONVERSATIONS,
	CHAT_STORAGE_LOCALSTORAGE_KEY,
	CONVERSATION_EVENTS,
	HEADERS,
	ROUTES
} from '$lib/constants';
import { ChatStorageLocation, MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { MigrationService } from '$lib/services/migration.service';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { chatStorageStore } from '$lib/stores/chat-storage.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { groupsStore } from '$lib/stores/groups.svelte';
import { initStores } from '$lib/stores/init';
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { versionStore } from '$lib/stores/version.svelte';
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

function createGroupElsewhere(id: string, name: string) {
	return server.sendAs(OTHER_WINDOW, 'POST', API_CONVERSATIONS.GROUPS, { id, name });
}

const isGet = (input: RequestInfo | URL, init: RequestInit | undefined, path: string) =>
	(init?.method ?? 'GET') === 'GET' &&
	new URL(input instanceof Request ? input.url : String(input), 'http://pico.test').pathname ===
		path;

/** Holds the answer to the next GET of `path` until `release`; the server reads at once. */
function holdAnswer(path: string) {
	const send = vi.mocked(globalThis.fetch).getMockImplementation()!;

	let release!: () => void;
	let started!: () => void;
	let held = false;

	const answered = new Promise<void>((resolve) => (release = resolve));
	const read = new Promise<void>((resolve) => (started = resolve));

	vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
		const response = await send(input, init);

		if (!held && isGet(input, init, path)) {
			held = true;
			started();
			await answered;
		}

		return response;
	});

	return { read, release };
}

/** Answers the next `times` GETs of `path` with 503, as a server that is down for a moment; `left = 0` ends it. */
function failReads(path: string, times: number) {
	const send = vi.mocked(globalThis.fetch).getMockImplementation()!;
	const failed = { count: 0, left: times };

	vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
		if (failed.left <= 0 || !isGet(input, init, path)) return send(input, init);

		failed.count++;
		failed.left--;

		return new Response(
			JSON.stringify({ error: { code: 'unavailable', message: 'unavailable' } }),
			{
				headers: { 'Content-Type': 'application/json' },
				status: 503
			}
		);
	});

	return failed;
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

	it('reloads the open chat once this window stops replying or editing in it', async () => {
		const { chat, user } = await openChat();

		chatActivityStore.markLocal(chat.id);
		await editElsewhere(chat.id, user.id, 'while replying');
		await renameElsewhere(chat.id, 'Renamed while replying');
		await vi.waitFor(() => expect(listName(chat.id)).toBe('Renamed while replying'));
		await settle();

		expect(shownText()).toEqual(['hi']);

		chatActivityStore.localEnded(chat.id);
		await vi.waitFor(() => expect(shownText()).toEqual(['while replying']));

		chatStore.setEditModeActive(() => {});
		await editElsewhere(chat.id, user.id, 'while editing');
		await renameElsewhere(chat.id, 'Renamed while editing');
		await vi.waitFor(() => expect(listName(chat.id)).toBe('Renamed while editing'));
		await settle();

		expect(shownText()).toEqual(['while replying']);

		chatStore.clearEditMode();
		await vi.waitFor(() => expect(shownText()).toEqual(['while editing']));
	});

	it('drops a skipped reload of a chat that is no longer open when the reply ends', async () => {
		const { chat, user } = await openChat('First');
		const second = await openChat('Second');

		expect(await conversationsStore.loadConversation(chat.id)).toBe(true);

		chatActivityStore.markLocal(chat.id);
		await editElsewhere(chat.id, user.id, 'while replying');
		await renameElsewhere(chat.id, 'Renamed while replying');
		await vi.waitFor(() => expect(listName(chat.id)).toBe('Renamed while replying'));
		await settle();
		expect(await conversationsStore.loadConversation(second.chat.id)).toBe(true);

		const itemReads = reads(chat.id);

		chatActivityStore.localEnded(chat.id);
		await settle(CONVERSATION_EVENTS.RELOAD_DEBOUNCE_MS + 100);

		expect(reads(chat.id)).toBe(itemReads);
		expect(conversationsStore.activeConversation?.id).toBe(second.chat.id);
	});

	it('keeps the chats this window made or renamed while a reload read the list', async () => {
		const { chat } = await openChat();
		const send = vi.mocked(globalThis.fetch).getMockImplementation()!;
		const listPath = (input: RequestInfo | URL) =>
			new URL(input instanceof Request ? input.url : String(input), 'http://pico.test').pathname;

		let answer!: () => void;
		let readStarted!: () => void;
		let held = false;

		const answered = new Promise<void>((resolve) => (answer = resolve));
		const started = new Promise<void>((resolve) => (readStarted = resolve));

		// the server reads the list at once, its answer arrives after this window's writes
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const response = await send(input, init);

			if (
				!held &&
				(init?.method ?? 'GET') === 'GET' &&
				listPath(input) === API_CONVERSATIONS.CONVERSATIONS
			) {
				held = true;
				readStarted();
				await answered;
			}

			return response;
		});

		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		await started;

		const mine = await conversationsStore.createConversation('Mine');

		await conversationsStore.updateConversationName(chat.id, 'Renamed here');
		answer();
		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));

		expect(listName(mine)).toBe('Mine');
		expect(listName(chat.id)).toBe('Renamed here');
	});

	it('keeps what this window changed in the open chat while a reload read it', async () => {
		const { chat, user } = await openChat();
		const held = holdAnswer(`${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}`);

		await editElsewhere(chat.id, user.id, 'edited elsewhere');
		await held.read;
		await conversationsStore.updateConversationName(chat.id, 'Renamed here');
		await conversationsStore.toggleConversationPin(chat.id);
		await conversationsStore.preferences.setCwd('/work');
		held.release();
		await vi.waitFor(() => expect(shownText()).toEqual(['edited elsewhere']));

		expect(conversationsStore.activeConversation).toMatchObject({
			cwd: '/work',
			name: 'Renamed here',
			pinned: true
		});
	});

	it('keeps a reply this window made in the open chat while a reload read it', async () => {
		const { chat, user } = await openChat();
		const held = holdAnswer(`${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}/items`);

		await renameElsewhere(chat.id, 'Renamed elsewhere');
		await held.read;

		// a reply that starts and ends while the reload reads, as chatStore makes one
		const reply = await DatabaseService.createMessageBranch(
			{ ...message(chat.id, 'my reply'), role: MessageRole.ASSISTANT },
			user.id
		);

		conversationsStore.addMessageToActive(reply);
		await conversationsStore.updateCurrentNode(reply.id);
		held.release();
		await vi.waitFor(() =>
			expect(conversationsStore.activeConversation?.name).toBe('Renamed elsewhere')
		);

		expect(shownText()).toEqual(['hi', 'my reply']);
		expect(conversationsStore.activeConversation?.currNode).toBe(reply.id);
	});

	it('keeps an in-place edit this window made in the open chat while a reload read it', async () => {
		const { chat, user } = await openChat();
		const held = holdAnswer(`${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}/items`);

		await replyElsewhere(chat.id, THEIR_REPLY, user.id, 'their reply');
		await held.read;
		conversationsStore.updateMessageAtIndex(0, { content: 'edited here' });
		await DatabaseService.updateMessage(user.id, { content: 'edited here' });
		held.release();

		await vi.waitFor(() => expect(shownText()).toEqual(['edited here', 'their reply']));
	});

	it('keeps the groups this window made, renamed or deleted while a reload read them', async () => {
		const kept = (await groupsStore.create('Kept'))!;
		const gone = (await groupsStore.create('Gone'))!;
		const held = holdAnswer(API_CONVERSATIONS.GROUPS);

		await createGroupElsewhere(THEIR_GROUP, 'Work');
		await held.read;

		const made = (await groupsStore.create('Made here'))!;

		await groupsStore.rename(kept.id, 'Renamed here');
		await groupsStore.remove(gone.id);
		held.release();
		await vi.waitFor(() => expect(groupsStore.get(THEIR_GROUP)?.name).toBe('Work'));

		expect(groupsStore.get(made.id)?.name).toBe('Made here');
		expect(groupsStore.get(kept.id)?.name).toBe('Renamed here');
		expect(groupsStore.get(gone.id)).toBeUndefined();
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

	it('reads everything again when the first stream opens after the chats were read', async () => {
		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		let open!: () => void;

		const opened = new Promise<void>((resolve) => (open = resolve));
		const listReads = reads();

		server.gate = async (request) => {
			if (request.path === API_CONVERSATIONS.EVENTS) await opened;
		};
		await chatStorageStore.select(ChatStorageLocation.SERVER);

		expect(reads() - listReads).toBe(1);

		// after the switch read the list, before the stream listens
		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		open();
		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));
	});

	it("reads a notice that comes during a switch's read of the list after that read", async () => {
		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		const held = holdAnswer(API_CONVERSATIONS.CONVERSATIONS);
		const switched = chatStorageStore.select(ChatStorageLocation.SERVER);

		await held.read;
		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		// time for the notice's reload to read the list, had it not waited
		await settle(CONVERSATION_EVENTS.RELOAD_DEBOUNCE_MS + 100);
		held.release();
		await switched;

		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));
	});

	it("reads a notice that comes during the page's first read of the list after that read", async () => {
		let firstRead!: Promise<void>;

		vi.spyOn(MigrationService, 'runAllMigrations').mockResolvedValue();
		vi.spyOn(settingsStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(permissionsStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(toolsStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(versionStore, 'initialize').mockImplementation(() => {});
		vi.spyOn(tabsStore, 'init').mockImplementation(() => {});
		// the switch in beforeEach already made the store's one first read, so this read stands in for it
		vi.spyOn(conversationsStore, 'initialize').mockImplementation(
			() => (firstRead = conversationsStore.loadConversations())
		);

		const held = holdAnswer(API_CONVERSATIONS.CONVERSATIONS);

		// the saved Pico Server choice opens the stream before the page reads the chats
		await initStores();
		await held.read;
		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		// time for the notice's reload to read the list, had it not waited
		await settle(CONVERSATION_EVENTS.RELOAD_DEBOUNCE_MS + 100);
		held.release();
		await firstRead;

		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));
	});

	it("follows the new stream's notices while a reload of the old one still reads", async () => {
		const held = holdAnswer(API_CONVERSATIONS.GROUPS);

		try {
			await createGroupElsewhere(THEIR_GROUP, 'Work');
			await held.read;
			await chatStorageStore.select(ChatStorageLocation.BROWSER);
			await chatStorageStore.select(ChatStorageLocation.SERVER);
			await createChatElsewhere(THEIR_CHAT, 'Theirs');

			await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));
		} finally {
			held.release();
		}
	});

	it('reads the chats once when the stream opens before them', async () => {
		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		const listReads = reads();

		await chatStorageStore.select(ChatStorageLocation.SERVER);
		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		await vi.waitFor(() => expect(listName(THEIR_CHAT)).toBe('Theirs'));
		await settle(CONVERSATION_EVENTS.RELOAD_DEBOUNCE_MS + 100);

		// the switch's read, then the one for the notice
		expect(reads() - listReads).toBe(2);
	});

	it.each([
		[
			'the groups',
			() => API_CONVERSATIONS.GROUPS,
			() => createGroupElsewhere(THEIR_GROUP, 'Work'),
			() => expect(groupsStore.get(THEIR_GROUP)?.name).toBe('Work')
		],
		[
			'the list',
			() => API_CONVERSATIONS.CONVERSATIONS,
			() => createChatElsewhere(THEIR_CHAT, 'Theirs'),
			() => expect(listName(THEIR_CHAT)).toBe('Theirs')
		],
		[
			'the open chat',
			(chat: DatabaseConversation) => `${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}`,
			(chat: DatabaseConversation, user: DatabaseMessage) =>
				editElsewhere(chat.id, user.id, 'edited elsewhere'),
			() => expect(shownText()).toEqual(['edited elsewhere'])
		]
	])(
		'reads %s again after a read failed while the stream stayed up',
		async (_, path, change, shown) => {
			const { chat, user } = await openChat();

			vi.spyOn(console, 'error').mockImplementation(() => {});

			const failed = failReads(path(chat), 1);

			await change(chat, user);
			await vi.waitFor(() => expect(failed.count).toBe(1));
			await vi.waitFor(shown, { timeout: CONVERSATION_EVENTS.INITIAL_RECONNECT_DELAY_MS + 2000 });
			chatStore.showErrorDialog(null);
		}
	);

	it('tries a failed read a few times, and keeps its notices for the next reload', async () => {
		const { chat, user } = await openChat();
		const realTimeout = globalThis.setTimeout;
		/** Moves the faked clock on, then lets the reads it started come back. */
		const tick = async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
			await new Promise((resolve) => realTimeout(resolve, 10));
		};

		vi.spyOn(console, 'error').mockImplementation(() => {});

		const failed = failReads(`${API_CONVERSATIONS.CONVERSATIONS}/${chat.id}`, Infinity);

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		try {
			await editElsewhere(chat.id, user.id, 'edited elsewhere');

			for (let i = 0; i < 120; i++) await tick(500);
		} finally {
			vi.useRealTimers();
		}

		expect(failed.count).toBe(1 + CONVERSATION_EVENTS.RELOAD_RETRIES);
		expect(shownText()).toEqual(['hi']);

		// a notice about another chat reloads the open one too
		failed.left = 0;
		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		await vi.waitFor(() => expect(shownText()).toEqual(['edited elsewhere']));
		chatStore.showErrorDialog(null);
	});

	it('drops a failed reload when the stream closes before it is tried again', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const failed = failReads(API_CONVERSATIONS.CONVERSATIONS, Infinity);

		await createChatElsewhere(THEIR_CHAT, 'Theirs');
		await vi.waitFor(() => expect(failed.count).toBe(1));
		await chatStorageStore.select(ChatStorageLocation.BROWSER);
		await settle(CONVERSATION_EVENTS.INITIAL_RECONNECT_DELAY_MS + 200);

		expect(failed.count).toBe(1);
		chatStore.showErrorDialog(null);
	});

	it('closes when chats go back to this browser', async () => {
		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		expect(server.eventStreams.size).toBe(0);
		expect(eventConnections()).toBe(1);
	});

	it('replaces the stream when the account changes and closes it when server storage becomes unavailable', async () => {
		// another account has made no choice, so its chats are in this browser
		const originalStream = [...server.eventStreams][0];

		settingsStore.config.apiKey = KEY_B;
		await chatStorageStore.sync();

		expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);
		expect(server.eventStreams.has(originalStream)).toBe(false);
		await vi.waitFor(() => expect(server.eventStreams.size).toBe(1));

		const next = server.requests.filter((r) => r.path === API_CONVERSATIONS.EVENTS).at(-1)!;

		expect(next.headers.get(HEADERS.AUTHORIZATION)).toBe(`${HEADERS.BEARER}${KEY_B}`);

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
