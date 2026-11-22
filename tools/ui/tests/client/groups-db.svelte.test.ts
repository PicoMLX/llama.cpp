import { TEST_CHAT_STORES } from '../fixtures/chat-stores';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import type { Group } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Groups live in their own table; deleting one must leave its chats in place,
 * out of any group. Both stores keep this contract: this browser's database
 * and Pico Server.
 */
describe.each(TEST_CHAT_STORES)('DatabaseService groups in $name', (store) => {
	const { at, id, stored } = store;

	function makeGroup(name: string): Group {
		return { createdAt: 0, id: id(name), name: `Group ${name}`, updatedAt: 0 };
	}

	beforeEach(async () => {
		await store.use();
		at(0);
	});

	afterEach(async () => {
		const groups = await DatabaseService.getAllGroups();

		await Promise.all(groups.map((group) => DatabaseService.deleteGroup(group.id)));

		const conversations = await DatabaseService.getAllConversations();

		await Promise.all(
			conversations.map((conversation) => DatabaseService.deleteConversation(conversation.id))
		);
		await DatabaseService.useStore(localChatStore);
	});

	it('round-trips a group', async () => {
		await DatabaseService.createGroup(makeGroup('a'));

		expect(await DatabaseService.getAllGroups()).toEqual([stored(makeGroup('a'), 1)]);
	});

	it('applies partial updates without dropping other fields', async () => {
		await DatabaseService.createGroup(makeGroup('a'));

		at(5);
		await DatabaseService.updateGroup(id('a'), { name: 'Renamed', updatedAt: 5 });

		expect(await DatabaseService.getAllGroups()).toEqual([
			stored({ ...makeGroup('a'), name: 'Renamed', updatedAt: 5 }, 2)
		]);
	});

	it('returns groups newest first by creation, whatever their updates', async () => {
		at(1);
		await DatabaseService.createGroup({ ...makeGroup('a'), createdAt: 1, updatedAt: 9 });
		at(2);
		await DatabaseService.createGroup({ ...makeGroup('b'), createdAt: 2, updatedAt: 3 });

		expect((await DatabaseService.getAllGroups()).map((group) => group.id)).toEqual([
			id('b'),
			id('a')
		]);
	});

	it('takes the chats out of a deleted group and keeps them', async () => {
		// Pico Server refuses a chat in a group that does not exist, so group b is made too
		await DatabaseService.createGroup(makeGroup('a'));
		await DatabaseService.createGroup(makeGroup('b'));
		const inGroup = await DatabaseService.createConversation('in', { groupId: id('a') });
		const elsewhere = await DatabaseService.createConversation('out', { groupId: id('b') });

		await DatabaseService.deleteGroup(id('a'));

		expect((await DatabaseService.getAllGroups()).map((group) => group.id)).toEqual([id('b')]);
		expect((await DatabaseService.getConversation(inGroup.id))?.groupId).toBeUndefined();
		expect((await DatabaseService.getConversation(elsewhere.id))?.groupId).toBe(id('b'));
	});

	it('keeps a forked chat in the group of the chat it was forked from', async () => {
		await DatabaseService.createGroup(makeGroup('a'));
		const source = await DatabaseService.createConversation('source', { groupId: id('a') });
		const rootId = await DatabaseService.createRootMessage(source.id);
		const fork = await DatabaseService.forkConversation(source.id, rootId, {
			includeAttachments: false,
			name: 'fork'
		});

		expect(fork.groupId).toBe(id('a'));
		expect((await DatabaseService.getConversation(fork.id))?.groupId).toBe(id('a'));
	});
});

/** Import exists only while chats are kept in this browser. */
describe('DatabaseService groups on import', () => {
	function makeGroup(id: string): Group {
		return { createdAt: 0, id, name: `Group ${id}`, updatedAt: 0 };
	}

	afterEach(async () => {
		const groups = await DatabaseService.getAllGroups();

		await Promise.all(groups.map((group) => DatabaseService.deleteGroup(group.id)));

		const conversations = await DatabaseService.getAllConversations();

		await Promise.all(
			conversations.map((conversation) => DatabaseService.deleteConversation(conversation.id))
		);
	});

	it("sorts imported chats into the file's group, by id, then by name, else a new one", async () => {
		await DatabaseService.createGroup(makeGroup('a'));
		await DatabaseService.createGroup({ ...makeGroup('b'), name: 'Research' });

		const chat = (id: string, groupId?: string) => ({
			conv: { currNode: '', groupId, id, lastModified: 0, name: id },
			messages: []
		});

		await DatabaseService.importConversations([
			{ ...chat('same-id', 'a'), group: { id: 'a', name: 'Other name' } },
			{ ...chat('same-name', 'x'), group: { id: 'x', name: 'Research' } },
			{ ...chat('new-group', 'y'), group: { id: 'y', name: 'Travel' } },
			chat('dangling', 'gone')
		]);

		const groupOf = async (id: string) => (await DatabaseService.getConversation(id))?.groupId;

		expect(await groupOf('same-id')).toBe('a');
		expect(await groupOf('same-name')).toBe('b');
		expect(await groupOf('new-group')).toBe('y');
		expect(await groupOf('dangling')).toBeUndefined();
		expect((await DatabaseService.getAllGroups()).map((group) => group.name)).toContain('Travel');
	});
});
