/**
 * DatabaseService - Persistence for conversations, messages and groups
 *
 * Forwards every call to the chat store in use: localChatStore (this
 * browser's IndexedDB) by default. A call still running when the store is
 * swapped rejects as aborted, so its late result never reaches the new
 * store's state. No reactive state; consumed by conversationsStore,
 * groupsStore and the chat flows.
 */

import { localChatStore } from './local-chat-store';
import type { ChatStore, ExportedConversation } from '$lib/types/database';
import type { Group } from '$lib/types/groups';
import { isAbortError } from '$lib/utils/abort';

export class DatabaseService {
	/** Bumped on every swap; a call that sees another value at its end is stale. */
	private static generation = 0;

	private static onError: ((error: unknown) => void) | undefined;

	private static store: ChatStore = localChatStore;

	static bulkDeleteConversations(ids: string[]): Promise<void> {
		return DatabaseService.call((store) => store.bulkDeleteConversations(ids));
	}

	static bulkToggleConversationPins(ids: string[]): Promise<Map<string, boolean>> {
		return DatabaseService.call((store) => store.bulkToggleConversationPins(ids));
	}

	static createConversation(
		name: string,
		fields?: Partial<Omit<DatabaseConversation, 'id' | 'name' | 'lastModified'>>
	): Promise<DatabaseConversation> {
		return DatabaseService.call((store) => store.createConversation(name, fields));
	}

	static createGroup(group: Group): Promise<Group> {
		return DatabaseService.call((store) => store.createGroup(group));
	}

	static createMessageBranch(
		message: Omit<DatabaseMessage, 'id'>,
		parentId: string | null
	): Promise<DatabaseMessage> {
		return DatabaseService.call((store) => store.createMessageBranch(message, parentId));
	}

	static createRootMessage(convId: string): Promise<string> {
		return DatabaseService.call((store) => store.createRootMessage(convId));
	}

	static createSystemMessage(
		convId: string,
		systemPrompt: string,
		parentId: string
	): Promise<DatabaseMessage> {
		return DatabaseService.call((store) =>
			store.createSystemMessage(convId, systemPrompt, parentId)
		);
	}

	static deleteConversation(id: string, options?: { deleteWithForks?: boolean }): Promise<void> {
		return DatabaseService.call((store) => store.deleteConversation(id, options));
	}

	static deleteGroup(id: string): Promise<void> {
		return DatabaseService.call((store) => store.deleteGroup(id));
	}

	static deleteMessage(messageId: string): Promise<void> {
		return DatabaseService.call((store) => store.deleteMessage(messageId));
	}

	static deleteMessageCascading(conversationId: string, messageId: string): Promise<string[]> {
		return DatabaseService.call((store) => store.deleteMessageCascading(conversationId, messageId));
	}

	/** Resolves once every write sent to the current store has settled. */
	static async flush(): Promise<void> {
		await DatabaseService.store.flush?.();
	}

	static forkConversation(
		sourceConvId: string,
		atMessageId: string,
		options: { name: string; includeAttachments: boolean }
	): Promise<DatabaseConversation> {
		return DatabaseService.call((store) =>
			store.forkConversation(sourceConvId, atMessageId, options)
		);
	}

	static getAllConversations(): Promise<DatabaseConversation[]> {
		return DatabaseService.call((store) => store.getAllConversations());
	}

	static getAllGroups(): Promise<Group[]> {
		return DatabaseService.call((store) => store.getAllGroups());
	}

	static getConversation(id: string): Promise<DatabaseConversation | undefined> {
		return DatabaseService.call((store) => store.getConversation(id));
	}

	static getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
		return DatabaseService.call((store) => store.getConversationMessages(convId));
	}

	static getConversationsWithMessages(
		convIds: string[]
	): Promise<Map<string, ExportedConversation>> {
		return DatabaseService.call((store) => store.getConversationsWithMessages(convIds));
	}

	static importConversations(
		data: ExportedConversation[]
	): Promise<{ imported: DatabaseConversation[]; skipped: DatabaseConversation[] }> {
		return DatabaseService.call((store) => store.importConversations(data));
	}

	static setConversationsGroup(ids: string[], groupId: string | null): Promise<void> {
		return DatabaseService.call((store) => store.setConversationsGroup(ids, groupId));
	}

	static toggleConversationPin(id: string): Promise<boolean> {
		return DatabaseService.call((store) => store.toggleConversationPin(id));
	}

	static updateConversation(
		id: string,
		updates: Partial<Omit<DatabaseConversation, 'id'>>
	): Promise<void> {
		return DatabaseService.call((store) => store.updateConversation(id, updates));
	}

	static updateCurrentNode(convId: string, nodeId: string): Promise<void> {
		return DatabaseService.call((store) => store.updateCurrentNode(convId, nodeId));
	}

	static updateGroup(id: string, updates: Partial<Omit<Group, 'id'>>): Promise<void> {
		return DatabaseService.call((store) => store.updateGroup(id, updates));
	}

	static updateMessage(id: string, updates: Partial<Omit<DatabaseMessage, 'id'>>): Promise<void> {
		return DatabaseService.call((store) => store.updateMessage(id, updates));
	}

	/**
	 * Sends later calls to `store`, once the current store's writes settle.
	 * Calls still running on the old store then reject as aborted.
	 *
	 * @param store - The store to use from now on
	 * @param onError - Sees every failed call of `store`, e.g. to show it to the user
	 */
	static async useStore(store: ChatStore, onError?: (error: unknown) => void): Promise<void> {
		await DatabaseService.flush();

		DatabaseService.generation++;
		DatabaseService.store = store;
		DatabaseService.onError = onError;
	}

	private static async call<T>(run: (store: ChatStore) => Promise<T>): Promise<T> {
		const { generation, onError, store } = DatabaseService;
		const outcome = await run(store).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ error, ok: false as const })
		);

		if (generation !== DatabaseService.generation) {
			throw new DOMException('The chat store changed while this call ran', 'AbortError');
		}

		if (outcome.ok) return outcome.value;

		if (!isAbortError(outcome.error)) onError?.(outcome.error);

		throw outcome.error;
	}
}
