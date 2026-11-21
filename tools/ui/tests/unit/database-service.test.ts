// DatabaseService forwards to one chat store at a time. A call still running
// when the store is swapped must not hand its late result to the new state.

import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import type { ChatStore } from '$lib/types/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, reject, resolve };
}

// only the methods a test calls
function fakeStore(methods: Partial<ChatStore>): ChatStore {
	return methods as ChatStore;
}

afterEach(async () => {
	await DatabaseService.useStore(localChatStore);
});

describe('DatabaseService store swap', () => {
	it('forwards calls to the store in use', async () => {
		const conversations = [{ currNode: '', id: 'a', lastModified: 1, name: 'A' }];

		await DatabaseService.useStore(fakeStore({ getAllConversations: async () => conversations }));

		expect(await DatabaseService.getAllConversations()).toBe(conversations);
	});

	it('drops a response that arrives after the swap', async () => {
		const late = deferred<DatabaseConversation[]>();

		await DatabaseService.useStore(fakeStore({ getAllConversations: () => late.promise }));

		const pending = DatabaseService.getAllConversations();

		await DatabaseService.useStore(fakeStore({ getAllConversations: async () => [] }));
		late.resolve([{ currNode: '', id: 'old', lastModified: 1, name: 'Old' }]);

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(await DatabaseService.getAllConversations()).toEqual([]);
	});

	it('drops an error that arrives after the swap without reporting it', async () => {
		const late = deferred<DatabaseConversation[]>();
		const onError = vi.fn();

		await DatabaseService.useStore(fakeStore({ getAllConversations: () => late.promise }), onError);

		const pending = DatabaseService.getAllConversations();

		await DatabaseService.useStore(fakeStore({}));
		late.reject(new Error('server down'));

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(onError).not.toHaveBeenCalled();
	});

	it('reports a failed call of the store in use', async () => {
		const onError = vi.fn();
		const failure = new Error('server down');

		await DatabaseService.useStore(
			fakeStore({
				getAllConversations: async () => {
					throw failure;
				}
			}),
			onError
		);

		await expect(DatabaseService.getAllConversations()).rejects.toBe(failure);
		expect(onError).toHaveBeenCalledWith(failure);
	});

	it('waits for the old store to settle its writes before swapping', async () => {
		const writes = deferred<void>();
		const order: string[] = [];

		await DatabaseService.useStore(
			fakeStore({
				flush: async () => {
					await writes.promise;
					order.push('flushed');
				}
			})
		);

		const swap = DatabaseService.useStore(fakeStore({})).then(() => order.push('swapped'));

		await Promise.resolve();
		writes.resolve();
		await swap;

		expect(order).toEqual(['flushed', 'swapped']);
	});
});
