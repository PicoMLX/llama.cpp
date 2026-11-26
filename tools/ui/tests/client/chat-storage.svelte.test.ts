// "Store chats in: This browser / Pico Server". Pico Server is offered only
// when /props says it can keep this account's chats and an API key is set.
// The choice is saved per server and account, never with the key itself, and
// a switch waits for running replies and writes before the list reloads from
// the new store, ignoring what the old store answers late.

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import SettingsChatImportExportTab from '$lib/components/app/settings/SettingsChat/SettingsChatImportExportTab.svelte';
import { CHAT_STORAGE_LOCALSTORAGE_KEY } from '$lib/constants';
import { ChatStorageLocation } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { chatStorageStore } from '$lib/stores/chat-storage.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: vi.fn(async () => {})
}));

const KEY_A = 'account-a-secret';
const KEY_B = 'account-b-secret';

let server: MockConversationsServer;

function setProps(conversationStorage: boolean) {
	serverStore.props = {
		conversation_storage: conversationStorage,
		default_generation_settings: { n_ctx: 2048 }
	} as unknown as ApiLlamaCppServerProps;
}

function deferred() {
	let resolve!: () => void;

	const promise = new Promise<void>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

async function seedServerChat(name: string) {
	const id = '00000000-0000-4000-8000-0000000000aa';

	await server.fetch('/v1/conversations', {
		body: JSON.stringify({ id, name }),
		method: 'POST'
	});

	return id;
}

async function clearBrowserChats() {
	const chats = await DatabaseService.getAllConversations();

	await DatabaseService.bulkDeleteConversations(chats.map((c) => c.id));
}

beforeEach(async () => {
	server = new MockConversationsServer();

	const passThrough = vi.mocked(globalThis.fetch).getMockImplementation();

	vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

		return url.includes('/v1/conversation') ? server.fetch(input, init) : passThrough!(input, init);
	});
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	settingsStore.config.apiKey = KEY_A;
	setProps(true);
	await clearBrowserChats();
});

afterEach(async () => {
	server.gate = null;
	chatActivityStore.localEnded('busy');
	await chatStorageStore.select(ChatStorageLocation.BROWSER);
	await clearBrowserChats();
	conversationsStore.conversations = [];
	settingsStore.config.apiKey = '';
	serverStore.props = null;
	localStorage.removeItem(CHAT_STORAGE_LOCALSTORAGE_KEY);
	vi.restoreAllMocks();
});

describe('chat storage setting', () => {
	it('is offered only with conversation_storage in /props and an API key', () => {
		expect(chatStorageStore.available).toBe(true);

		settingsStore.config.apiKey = '';
		expect(chatStorageStore.available).toBe(false);

		settingsStore.config.apiKey = KEY_A;
		setProps(false);
		expect(chatStorageStore.available).toBe(false);
	});

	it('saves the choice per server and account without the key', async () => {
		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);

		const saved = localStorage.getItem(CHAT_STORAGE_LOCALSTORAGE_KEY)!;

		expect(saved).not.toContain(KEY_A);
		expect(Object.keys(JSON.parse(saved))).toEqual([
			expect.stringMatching(new RegExp(`^${window.location.origin}`))
		]);

		// another account on the same server has made no choice
		settingsStore.config.apiKey = KEY_B;
		await chatStorageStore.sync();
		expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);

		settingsStore.config.apiKey = KEY_A;
		await chatStorageStore.sync();
		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
	});

	it('goes back to this browser when Pico Server stops offering it', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);

		setProps(false);
		await chatStorageStore.sync();

		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
	});

	it('reads chats from Pico Server by default on a fresh signed-in browser', async () => {
		// a fresh page: the store in use starts as this browser's
		await DatabaseService.useStore(localChatStore);
		chatStorageStore.location = ChatStorageLocation.BROWSER;

		const id = await seedServerChat('On the server');

		await chatStorageStore.initialize();

		expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);
		expect((await DatabaseService.getAllConversations()).map((c) => c.id)).toEqual([id]);
	});

	it('applies the choice on this page when it cannot be saved', async () => {
		const setItem = Storage.prototype.setItem;
		const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key === CHAT_STORAGE_LOCALSTORAGE_KEY) {
				throw new DOMException('Quota exceeded', 'QuotaExceededError');
			}

			setItem.call(this, key, value);
		});
		const id = await seedServerChat('On the server');

		await chatStorageStore.select(ChatStorageLocation.SERVER);

		expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);
		expect(conversationsStore.conversations.map((c) => c.id)).toEqual([id]);

		// as when /props or the key change again
		await chatStorageStore.sync();

		expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);

		await chatStorageStore.select(ChatStorageLocation.BROWSER);

		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
		expect(localStorage.getItem(CHAT_STORAGE_LOCALSTORAGE_KEY)).toBeNull();

		full.mockRestore();
	});
});

describe('switching chat storage', () => {
	it('waits for a running reply, then reloads the list from the new store', async () => {
		await DatabaseService.createConversation('In this browser');
		await conversationsStore.loadConversations();

		const serverChat = await seedServerChat('On the server');

		chatActivityStore.markLocal('busy');

		const switched = chatStorageStore.select(ChatStorageLocation.SERVER);

		await new Promise((resolve) => setTimeout(resolve, 300));

		const whileReplying = {
			location: chatStorageStore.location,
			names: conversationsStore.conversations.map((c) => c.name),
			pending: chatStorageStore.pending
		};

		chatActivityStore.localEnded('busy');
		await switched;

		expect(whileReplying).toEqual({
			location: ChatStorageLocation.BROWSER,
			names: ['In this browser'],
			pending: ChatStorageLocation.SERVER
		});
		expect(chatStorageStore.location).toBe(ChatStorageLocation.SERVER);
		expect(chatStorageStore.pending).toBeNull();
		expect(conversationsStore.conversations.map((c) => c.id)).toEqual([serverChat]);
	});

	it('waits for pending writes before leaving Pico Server', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);

		const chat = await DatabaseService.createConversation('Chat');
		const write = deferred();

		server.gate = async (request) => {
			if (request.method === 'POST') await write.promise;
		};

		const saved = DatabaseService.updateConversation(chat.id, { pinned: true });
		const switched = chatStorageStore.select(ChatStorageLocation.BROWSER);

		await new Promise((resolve) => setTimeout(resolve, 50));

		const locationWhileWriting = chatStorageStore.location;

		write.resolve();
		await Promise.all([saved, switched]);

		expect(locationWhileWriting).toBe(ChatStorageLocation.SERVER);
		expect(server.conversations.get(chat.id)?.pinned).toBe(true);
		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
	});

	it('sends the writes it waits for with the key of the account that made them', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);

		const chat = await DatabaseService.createConversation('Chat');
		const write = deferred();

		server.gate = async (request) => {
			if (request.method === 'POST') await write.promise;
		};
		server.requests = [];

		const saved = Promise.all([
			DatabaseService.updateConversation(chat.id, { pinned: true }),
			DatabaseService.updateConversation(chat.id, { name: 'Renamed' })
		]);

		// This account chooses browser storage while the first account has a write in flight.
		settingsStore.config.apiKey = KEY_B;

		const switched = chatStorageStore.select(ChatStorageLocation.BROWSER);

		await new Promise((resolve) => setTimeout(resolve, 50));
		write.resolve();
		await Promise.all([saved, switched]);

		expect(server.requests.map((r) => r.headers.get('Authorization'))).toEqual([
			`Bearer ${KEY_A}`,
			`Bearer ${KEY_A}`
		]);
		expect(server.conversations.get(chat.id)).toMatchObject({ name: 'Renamed', pinned: true });
		expect(chatStorageStore.location).toBe(ChatStorageLocation.BROWSER);
	});

	it('drops the group picked for the next chat, which the new store does not have', async () => {
		conversationsStore.preferences.pendingGroupId = '00000000-0000-4000-8000-0000000000bb';

		await chatStorageStore.select(ChatStorageLocation.SERVER);

		const id = await conversationsStore.createConversation('First on the server');

		expect(server.conversations.get(id)?.group_id).toBeNull();
	});

	it('ignores a list the old store answers after the switch', async () => {
		await DatabaseService.createConversation('In this browser');
		await chatStorageStore.select(ChatStorageLocation.SERVER);
		await seedServerChat('On the server');

		const list = deferred();

		server.gate = async (request) => {
			if (request.method === 'GET' && request.path === '/v1/conversations') await list.promise;
		};

		const lateLoad = conversationsStore.loadConversations();

		await chatStorageStore.select(ChatStorageLocation.BROWSER);
		list.resolve();

		await expect(lateLoad).rejects.toMatchObject({ name: 'AbortError' });
		expect(conversationsStore.conversations.map((c) => c.name)).toEqual(['In this browser']);
	});
});

describe('import with chats on Pico Server', () => {
	it('is turned off with a short explanation, and export stays on', async () => {
		await chatStorageStore.select(ChatStorageLocation.SERVER);

		const screen = render(SettingsChatImportExportTab);

		await tick();

		const button = (text: string) =>
			[...screen.container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

		expect(button('Import conversations')?.disabled).toBe(true);
		expect(button('Export conversations')?.disabled).toBe(false);
		expect(screen.container.textContent).toContain(
			"Import isn't available while chats are stored on Pico Server"
		);
		expect(screen.container.textContent).toContain('Store chats in');
	});

	it('stays on while chats are in this browser', async () => {
		const screen = render(SettingsChatImportExportTab);

		await tick();

		const importButton = [...screen.container.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Import conversations')
		);

		expect(importButton?.disabled).toBe(false);
	});
});
