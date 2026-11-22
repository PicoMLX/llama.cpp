// The two chat stores DatabaseService can forward to, set up for tests that
// run the same expectations against both: this browser's IndexedDB and a
// ServerChatStore over the in-memory Pico Server mock.

import { MockConversationsServer } from './mock-conversations-server';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ServerChatStore } from '$lib/services/server-chat-store';
import { vi } from 'vitest';

export interface TestChatStore {
	name: string;
	/** The mock server behind the server store, null for this browser's store. */
	server: MockConversationsServer | null;
	/** Points DatabaseService at the store, with an empty mock server. */
	use(): Promise<void>;
	/** A record id the store accepts, the same for the same name. */
	id(name: string): string;
	/** Sets the server clock; this browser's store keeps the times it is given. */
	at(ms: number): void;
	/** What a record the test wrote reads back as: the server adds its version. */
	stored<T extends object>(record: T, version: number): T;
}

const names = new Map<string, string>();

function uuidFor(name: string): string {
	let id = names.get(name);

	if (!id) {
		id = `00000000-0000-4000-8000-${(names.size + 1).toString(16).padStart(12, '0')}`;
		names.set(name, id);
	}

	return id;
}

const browserStore: TestChatStore = {
	at: () => {},
	id: (name) => name,
	name: 'this browser',
	server: null,
	stored: (record) => record,
	use: () => DatabaseService.useStore(localChatStore)
};
const serverStore: TestChatStore = {
	at: (ms) => {
		serverStore.server!.now = ms;
	},
	id: uuidFor,
	name: 'Pico Server',
	server: null,
	stored: (record, version) => ({ ...record, version }),
	use: async () => {
		const server = new MockConversationsServer();

		serverStore.server = server;
		vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
		await DatabaseService.useStore(new ServerChatStore('test-key'));
	}
};

export const TEST_CHAT_STORES = [browserStore, serverStore];
