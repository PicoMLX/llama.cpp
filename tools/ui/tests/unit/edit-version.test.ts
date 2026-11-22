// An edit a person makes in place, or a rename, carries the version the record
// had when the edit began. Pico Server refuses the save if another window
// changed the record since, even when this window read the record again in
// between. Writes the reply makes carry no version.

import { MockConversationsServer } from '../fixtures/mock-conversations-server';
import { ERROR_MESSAGES } from '$lib/constants';
import { MessageRole, MessageType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ServerChatStore } from '$lib/services/server-chat-store';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let server: MockConversationsServer;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

function message(convId: string, role: MessageRole, content: string): Omit<DatabaseMessage, 'id'> {
	return {
		children: [],
		content,
		convId,
		parent: null,
		role,
		timestamp: Date.now(),
		toolCalls: '',
		type: MessageType.TEXT
	};
}

async function openChat(withReply: boolean) {
	const conversation = await DatabaseService.createConversation('Chat');
	const rootId = await DatabaseService.createRootMessage(conversation.id);
	const user = await DatabaseService.createMessageBranch(
		message(conversation.id, MessageRole.USER, 'hello'),
		rootId
	);
	const reply = withReply
		? await DatabaseService.createMessageBranch(
				message(conversation.id, MessageRole.ASSISTANT, ''),
				user.id
			)
		: null;

	expect(await conversationsStore.loadConversation(conversation.id)).toBe(true);

	const shown = (id: string) => conversationsStore.activeMessages.find((m) => m.id === id)!;

	return { conversation, reply, shown, user };
}

function itemText(convId: string, itemId: string): string {
	return server.items.get(convId)!.get(itemId)!.content[0].text;
}

const sentVersions = () =>
	server.requests.filter((r) => r.method === 'POST').map((r) => r.body?.if_version);

beforeEach(async () => {
	server = new MockConversationsServer();
	onError = vi.fn<(error: unknown) => void>();
	vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
	await DatabaseService.useStore(new ServerChatStore('test-key'), onError);
});

afterEach(async () => {
	conversationsStore.clearActiveConversation();
	await DatabaseService.useStore(localChatStore);
	vi.restoreAllMocks();
});

describe('in-place message edits', () => {
	it('send the version from when the edit began, even after the messages are read again', async () => {
		const { conversation, shown, user } = await openChat(false);
		const version = await DatabaseService.versionForEdit(shown(user.id));

		server.editElsewhere(conversation.id, user.id, 'from another window');
		// another read before the save sees the new version; the edit must not take it
		await conversationsStore.getConversationMessages(conversation.id);
		server.requests = [];

		vi.spyOn(console, 'error').mockImplementation(() => {});
		await chatStore.editMessageWithBranching(user.id, 'mine', undefined, version);

		expect(sentVersions()).toEqual([1]);
		expect(itemText(conversation.id, user.id)).toBe('from another window');
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: ERROR_MESSAGES.CHAT_STORAGE.STALE_VERSION })
		);
	});

	it("start the next edit from this window's own save", async () => {
		const { conversation, shown, user } = await openChat(true);

		await chatStore.editUserMessagePreserveResponses(
			user.id,
			'first',
			undefined,
			await DatabaseService.versionForEdit(shown(user.id))
		);
		await chatStore.editUserMessagePreserveResponses(
			user.id,
			'second',
			undefined,
			await DatabaseService.versionForEdit(shown(user.id))
		);

		expect(onError).not.toHaveBeenCalled();
		expect(itemText(conversation.id, user.id)).toBe('second');
	});

	it('edit a reply in place after its own writes, and only the edit sends a version', async () => {
		const { conversation, reply, shown } = await openChat(true);

		server.requests = [];
		// what the reply writes when it finishes, nobody awaiting them
		void DatabaseService.updateMessage(reply!.id, { content: 'answer' });
		void DatabaseService.updateMessage(reply!.id, { model: 'qwen' });

		const version = await DatabaseService.versionForEdit(shown(reply!.id));

		await chatStore.editAssistantMessage(reply!.id, 'better answer', false, version);

		expect(onError).not.toHaveBeenCalled();
		expect(itemText(conversation.id, reply!.id)).toBe('better answer');
		expect(sentVersions()).toEqual([undefined, undefined, 3]);
	});

	it("are refused when this window's own write lands after an edit from another window", async () => {
		const { conversation, reply, shown } = await openChat(true);

		server.editElsewhere(conversation.id, reply!.id, 'from another window');
		// the timings the reply writes when it ends get a version past the other edit
		await DatabaseService.updateMessage(reply!.id, { timings: { predicted_n: 1 } as never });
		server.requests = [];

		const version = await DatabaseService.versionForEdit(shown(reply!.id));

		vi.spyOn(console, 'error').mockImplementation(() => {});
		await chatStore.editAssistantMessage(reply!.id, 'mine', false, version);

		expect(sentVersions()).toEqual([1]);
		expect(itemText(conversation.id, reply!.id)).toBe('from another window');
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: ERROR_MESSAGES.CHAT_STORAGE.STALE_VERSION })
		);
	});

	it("start after this window's own write once the other window's edit was read", async () => {
		const { conversation, reply } = await openChat(true);

		server.editElsewhere(conversation.id, reply!.id, 'from another window');
		await conversationsStore.loadConversation(conversation.id);
		await DatabaseService.updateMessage(reply!.id, { timings: { predicted_n: 1 } as never });

		const shown = conversationsStore.activeMessages.find((m) => m.id === reply!.id)!;
		const version = await DatabaseService.versionForEdit(shown);

		await chatStore.editAssistantMessage(reply!.id, 'mine', false, version);

		expect(onError).not.toHaveBeenCalled();
		expect(itemText(conversation.id, reply!.id)).toBe('mine');
	});
});

describe('chat renames', () => {
	it('send the version from when the rename began', async () => {
		const { conversation } = await openChat(false);
		const chat = conversationsStore.conversations.find((c) => c.id === conversation.id) ?? {
			id: conversation.id,
			version: conversation.version
		};
		const version = await DatabaseService.versionForEdit(chat);

		server.conversations.get(conversation.id)!.name = 'Renamed elsewhere';
		server.conversations.get(conversation.id)!.version++;
		server.requests = [];

		await conversationsStore.updateConversationName(conversation.id, 'Mine', version);

		expect(server.requests[0].body).toEqual({ if_version: 1, name: 'Mine' });
		expect(server.conversations.get(conversation.id)!.name).toBe('Renamed elsewhere');
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: ERROR_MESSAGES.CHAT_STORAGE.STALE_VERSION })
		);
	});

	it.each([
		['a pin', (id: string) => DatabaseService.toggleConversationPin(id)],
		['a setting', (id: string) => DatabaseService.updateConversation(id, { cwd: '/work' })],
		[
			'the current message',
			(id: string, userId: string) => DatabaseService.updateCurrentNode(id, userId)
		],
		[
			'a group',
			async (id: string) => {
				const group = await DatabaseService.createGroup({
					createdAt: 0,
					id: '22222222-2222-4222-8222-222222222222',
					name: 'Work',
					updatedAt: 0
				});

				await DatabaseService.setConversationsGroup([id], group.id);
			}
		]
	])(
		'are refused when this window saved %s after a rename from another window',
		async (_, save) => {
			const { conversation, user } = await openChat(false);

			server.conversations.get(conversation.id)!.name = 'Renamed elsewhere';
			server.conversations.get(conversation.id)!.version++;
			// the answer carries the other window's version, which this window did not write
			await save(conversation.id, user.id);
			server.requests = [];

			const version = await DatabaseService.versionForEdit({
				id: conversation.id,
				version: conversation.version
			});

			vi.spyOn(console, 'error').mockImplementation(() => {});
			await conversationsStore.updateConversationName(conversation.id, 'Mine', version);

			expect(server.requests[0].body).toEqual({ if_version: 1, name: 'Mine' });
			expect(server.conversations.get(conversation.id)!.name).toBe('Renamed elsewhere');
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: ERROR_MESSAGES.CHAT_STORAGE.STALE_VERSION })
			);
		}
	);

	it('are refused when this window deleted a message after a rename from another window', async () => {
		const { conversation, user } = await openChat(true);

		server.conversations.get(conversation.id)!.name = 'Renamed elsewhere';
		server.conversations.get(conversation.id)!.version++;
		await DatabaseService.deleteMessageCascading(conversation.id, user.id);
		server.requests = [];

		const version = await DatabaseService.versionForEdit({
			id: conversation.id,
			version: conversation.version
		});

		vi.spyOn(console, 'error').mockImplementation(() => {});
		await conversationsStore.updateConversationName(conversation.id, 'Mine', version);

		expect(server.requests[0].body).toEqual({ if_version: 1, name: 'Mine' });
		expect(server.conversations.get(conversation.id)!.name).toBe('Renamed elsewhere');
	});

	it('start from the version an automatic title left, which sends none itself', async () => {
		const { conversation } = await openChat(false);

		server.requests = [];
		await conversationsStore.applyTitleFromContent(conversation.id, 'A title from the message');

		expect(server.requests[0].body).not.toHaveProperty('if_version');

		const version = await DatabaseService.versionForEdit({
			id: conversation.id,
			version: conversation.version
		});

		await conversationsStore.updateConversationName(conversation.id, 'Mine', version);

		expect(onError).not.toHaveBeenCalled();
		expect(server.conversations.get(conversation.id)!.name).toBe('Mine');
	});
});
