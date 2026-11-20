// A database written before chat groups (schema version 1) opens at version 2 with its chats and messages kept, and takes groups.

import { DB_NAME, IDXDB_STORES_V1 } from '$lib/constants';
import { MessageRole, MessageType } from '$lib/enums';
import Dexie from 'dexie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONVERSATION = { currNode: 'm1', id: 'c1', lastModified: 1, name: 'Before groups' };
const MESSAGE = {
	children: [],
	content: 'hello',
	convId: 'c1',
	id: 'm1',
	parent: null,
	role: MessageRole.USER,
	timestamp: 1,
	type: MessageType.TEXT
};

beforeAll(async () => {
	await Dexie.delete(DB_NAME);

	const v1 = new Dexie(DB_NAME);

	v1.version(1).stores(IDXDB_STORES_V1);
	await v1.table('conversations').add(CONVERSATION);
	await v1.table('messages').add(MESSAGE);
	v1.close();
});

// other test files share this database, so remove what this one wrote
afterAll(async () => {
	const { DatabaseService } = await import('$lib/services/database.service');

	await DatabaseService.deleteGroup('g1');
	await DatabaseService.deleteConversation('c1');
});

describe('database written before chat groups', () => {
	it('keeps its chats and messages and takes groups', async () => {
		// imported here so the app's database first opens on the version 1 data
		const { DatabaseService } = await import('$lib/services/database.service');

		expect(await DatabaseService.getConversation('c1')).toMatchObject(CONVERSATION);
		expect(await DatabaseService.getConversationMessages('c1')).toMatchObject([MESSAGE]);

		await DatabaseService.createGroup({ createdAt: 0, id: 'g1', name: 'Work', updatedAt: 0 });

		expect((await DatabaseService.getAllGroups()).map((group) => group.id)).toEqual(['g1']);
	});
});
