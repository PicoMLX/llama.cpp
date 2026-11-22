/**
 * ServerChatStore - Pico Server persistence for conversations, messages and groups
 *
 * Talks to the /v1/conversations and /v1/conversation_groups routes and maps
 * their snake_case records to the camelCase DatabaseConversation,
 * DatabaseMessage and Group the UI uses. The client makes every id. Writes to
 * one chat run one at a time in call order, so writes nobody awaits (model,
 * timings, attachments) still land in order, and a read of a chat waits for
 * its writes. The server derives each message's children from the parents it
 * gets, so they are never sent. Only a person's in-place edits and renames
 * send `if_version`, from the version kept when the edit began. Every
 * request carries this window's id, which the change notices on the events
 * stream name as their origin. No reactive state; DatabaseService forwards to
 * one instance while chats are kept on Pico Server.
 */

import { base } from '$app/paths';
import {
	API_CONVERSATIONS,
	CONVERSATION_EVENTS,
	CONVERSATION_SETTINGS_KEYS,
	ERROR_MESSAGES,
	HEADERS,
	SSE_EVENT_PREFIX,
	SSE_LINE_SEPARATOR
} from '$lib/constants';
import { ConversationEventType, MessageRole, MessageType } from '$lib/enums';
import type {
	ApiConversation,
	ApiConversationDeleted,
	ApiConversationEvent,
	ApiConversationGroup,
	ApiConversationItem,
	ApiConversationItemInput,
	ApiConversationTextPart,
	ApiList
} from '$lib/types/api';
import type { ChatStore, ChatStoreWriteOptions, ExportedConversation } from '$lib/types/database';
import type { Group } from '$lib/types/groups';
import { apiDelete, ApiError, apiFetch, type ApiFetchOptions, apiPost } from '$lib/utils/api-fetch';
import { extractSseDataPayload, splitSseRecords } from '$lib/utils/sse';
import { uuid } from '$lib/utils/uuid';

type Body = Record<string, unknown>;

/** Message fields stored as an item field of their own, by web UI name. */
const OPTIONAL_ITEM_FIELDS: Record<string, string> = {
	completionId: 'completion_id',
	extra: 'attachments',
	isSynthetic: 'is_synthetic',
	kept: 'kept',
	model: 'model',
	reasoningContent: 'reasoning_content',
	timings: 'timings',
	toolCallId: 'tool_call_id',
	toolCwd: 'tool_cwd'
};
const SETTINGS_KEYS: readonly string[] = CONVERSATION_SETTINGS_KEYS;
/** This window's id, made once per page load; Pico Server names it as the origin of the change notices its writes cause. */
const CLIENT_ID = uuid();

function conversationPath(id: string): string {
	return `${API_CONVERSATIONS.CONVERSATIONS}/${encodeURIComponent(id)}`;
}

function itemsPath(convId: string): string {
	return `${conversationPath(convId)}/items`;
}

function itemPath(convId: string, itemId: string): string {
	return `${itemsPath(convId)}/${encodeURIComponent(itemId)}`;
}

function groupPath(id: string): string {
	return `${API_CONVERSATIONS.GROUPS}/${encodeURIComponent(id)}`;
}

function isMissing(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** Runs a request; a stale edit comes back as the message the error dialog shows. */
async function request<T>(send: () => Promise<T>): Promise<T> {
	try {
		return await send();
	} catch (error) {
		if (error instanceof ApiError && error.code === 'stale_version') {
			throw new ApiError(ERROR_MESSAGES.CHAT_STORAGE.STALE_VERSION, error.status, error.code);
		}

		throw error;
	}
}

function withoutUndefined<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

function textPart(role: string, text: string): ApiConversationTextPart {
	return role === MessageRole.ASSISTANT
		? { annotations: [], text, type: 'output_text' }
		: { text, type: 'input_text' };
}

function parseToolCalls(toolCalls: string | undefined): unknown[] | null {
	if (!toolCalls) return null;

	const parsed: unknown = JSON.parse(toolCalls);

	if (!Array.isArray(parsed)) throw new Error('Tool calls must be a JSON array');

	return parsed;
}

function toConversation(record: ApiConversation): DatabaseConversation {
	const conversation: DatabaseConversation = {
		currNode: record.current_item_id ?? '',
		id: record.id,
		lastModified: record.last_modified_ms,
		name: record.name,
		pinned: record.pinned,
		version: record.version
	};

	if (record.group_id) conversation.groupId = record.group_id;

	if (record.forked_from_conversation_id) {
		conversation.forkedFromConversationId = record.forked_from_conversation_id;
	}

	const fields = conversation as unknown as Body;

	for (const key of SETTINGS_KEYS) {
		const value = record.settings?.[key];

		if (value !== undefined && value !== null) fields[key] = value;
	}

	return conversation;
}

/** Maps the keys present in `updates`; `undefined` becomes `null`, which clears the field. */
function toConversationPatch(updates: Partial<DatabaseConversation>): Body {
	const patch: Body = {};
	const settings: Body = {};

	for (const [key, value] of Object.entries(updates)) {
		if (key === 'name') patch.name = value;
		else if (key === 'pinned') patch.pinned = Boolean(value);
		else if (key === 'groupId') patch.group_id = value ?? null;
		else if (key === 'currNode') patch.current_item_id = value || null;
		else if (SETTINGS_KEYS.includes(key)) settings[key] = value ?? null;
		// lastModified is the server's, bumped when items are added; forks are the server's too
	}

	if (Object.keys(settings).length > 0) patch.settings = settings;

	return patch;
}

function toMessage(convId: string, item: ApiConversationItem): DatabaseMessage {
	const message: DatabaseMessage = {
		children: item.children_ids ?? [],
		content: item.content?.[0]?.text ?? '',
		convId,
		id: item.id,
		parent: item.parent_id,
		role: item.role,
		timestamp: item.timestamp_ms,
		type: item.message_type,
		version: item.version
	};
	const fields = message as unknown as Body;
	const record = item as unknown as Body;

	for (const [key, field] of Object.entries(OPTIONAL_ITEM_FIELDS)) {
		const value = record[field];

		if (value !== undefined && value !== null) fields[key] = value;
	}

	if (item.tool_calls) message.toolCalls = JSON.stringify(item.tool_calls);

	return message;
}

function toItemInput(message: DatabaseMessage): ApiConversationItemInput {
	const input: ApiConversationItemInput = {
		content: [textPart(message.role, message.content)],
		id: message.id,
		message_type: message.type,
		parent_id: message.parent,
		role: message.role,
		timestamp_ms: message.timestamp
	};
	const fields = input as unknown as Body;
	const source = message as unknown as Body;

	for (const [key, field] of Object.entries(OPTIONAL_ITEM_FIELDS)) {
		const value = source[key];

		if (value !== undefined && value !== null) fields[field] = value;
	}

	const toolCalls = parseToolCalls(message.toolCalls);

	if (toolCalls) input.tool_calls = toolCalls;

	return input;
}

/**
 * Maps the keys present in `updates`; `undefined` becomes `null`, which clears
 * the field. A new parent moves the item. Children are the server's to derive,
 * and the id, chat, role and type never change.
 */
function toItemPatch(role: string, updates: Partial<DatabaseMessage>): Body {
	const patch: Body = {};

	for (const [key, value] of Object.entries(updates)) {
		if (key === 'content') patch.content = [textPart(role, (value as string | undefined) ?? '')];
		else if (key === 'parent') patch.parent_id = value ?? null;
		else if (key === 'timestamp') patch.timestamp_ms = value;
		else if (key === 'toolCalls') patch.tool_calls = parseToolCalls(value as string | undefined);
		else if (key in OPTIONAL_ITEM_FIELDS) patch[OPTIONAL_ITEM_FIELDS[key]] = value ?? null;
	}

	return patch;
}

/** One notice of the events stream, or null for a keep-alive comment or a malformed record. */
function parseEvent(record: string): ApiConversationEvent | null {
	const name = record
		.split(SSE_LINE_SEPARATOR)
		.find((line) => line.startsWith(SSE_EVENT_PREFIX))
		?.slice(SSE_EVENT_PREFIX.length)
		.trim();
	const payload = extractSseDataPayload(record);

	if (!name || !payload) return null;

	try {
		return { data: JSON.parse(payload), event: name as ConversationEventType };
	} catch {
		return null;
	}
}

function toGroup(record: ApiConversationGroup): Group {
	return {
		createdAt: record.created_at_ms,
		id: record.id,
		name: record.name,
		updatedAt: record.updated_at_ms,
		version: record.version
	};
}

export class ServerChatStore implements ChatStore {
	/** Sent with every request: writes still queued when the API key changes go out as the account that made them. Also carries this window's id. */
	private auth: ApiFetchOptions;

	/** The last record of each chat the server sent, for forks and pin toggles. */
	private conversations = new Map<string, DatabaseConversation>();

	/** Chat and role of each message seen: the routes need the chat, the text part the role. */
	private items = new Map<string, { convId: string; role: string }>();

	/** Tail of each chat's (or group's) write queue, by its id. */
	private queues = new Map<string, Promise<void>>();

	/** Versions the server gave this window's own writes, by record id; reads never add to them. */
	private versions = new Map<string, Set<number>>();

	/** Writes to chats that finished so far; the count after each chat's last one is in {@link written}. */
	private writes = 0;

	/** {@link writes} once each chat's last write finished, by id: a read that began before it leaves the chat's copy alone. */
	private written = new Map<string, number>();

	async bulkDeleteConversations(ids: string[]): Promise<void> {
		const cleanIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);

		for (const id of cleanIds) {
			await this.deleteConversation(id);
		}
	}

	async bulkToggleConversationPins(ids: string[]): Promise<Map<string, boolean>> {
		const cleanIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
		const states = await Promise.all(
			cleanIds.map(async (id) => {
				const conversation = await this.knownConversation(id);

				if (!conversation) return null;

				const pinned = !conversation.pinned;

				await this.updateConversation(id, { pinned });

				return [id, pinned] as const;
			})
		);

		return new Map(states.filter((state) => state !== null));
	}

	/** @param apiKey - Key of the account whose chats this store keeps */
	constructor(apiKey: string) {
		this.auth = {
			headers: {
				[HEADERS.AUTHORIZATION]: `${HEADERS.BEARER}${apiKey}`,
				[HEADERS.X_PICO_CLIENT_ID_HEADER]: CLIENT_ID
			}
		};
	}

	async createConversation(
		name: string,
		fields?: Partial<Omit<DatabaseConversation, 'id' | 'name' | 'lastModified'>>
	): Promise<DatabaseConversation> {
		const id = uuid();
		const body: Body = { ...toConversationPatch(withoutUndefined(fields ?? {})), id, name };

		delete body.current_item_id;

		return this.enqueue(id, async () =>
			this.trackWrite(
				await request(() =>
					apiPost<ApiConversation>(API_CONVERSATIONS.CONVERSATIONS, body, this.auth)
				)
			)
		);
	}

	async createGroup(group: Group): Promise<Group> {
		return this.enqueue(group.id, async () =>
			toGroup(
				await request(() =>
					apiPost<ApiConversationGroup>(
						API_CONVERSATIONS.GROUPS,
						{ id: group.id, name: group.name },
						this.auth
					)
				)
			)
		);
	}

	async createMessageBranch(
		message: Omit<DatabaseMessage, 'id'>,
		parentId: string | null
	): Promise<DatabaseMessage> {
		const newMessage: DatabaseMessage = {
			...message,
			children: [],
			id: uuid(),
			parent: parentId,
			toolCalls: message.toolCalls ?? ''
		};
		const [item] = await this.addItems(message.convId, [newMessage], newMessage.id);

		return { ...newMessage, version: item.version };
	}

	async createRootMessage(convId: string): Promise<string> {
		const rootMessage: DatabaseMessage = {
			children: [],
			content: '',
			convId,
			id: uuid(),
			parent: null,
			role: MessageRole.SYSTEM,
			timestamp: Date.now(),
			toolCalls: '',
			type: MessageType.ROOT
		};

		await this.addItems(convId, [rootMessage]);

		return rootMessage.id;
	}

	async createSystemMessage(
		convId: string,
		systemPrompt: string,
		parentId: string
	): Promise<DatabaseMessage> {
		const trimmedPrompt = systemPrompt.trim();

		if (!trimmedPrompt) {
			throw new Error('Cannot create system message with empty content');
		}

		const systemMessage: DatabaseMessage = {
			children: [],
			content: trimmedPrompt,
			convId,
			id: uuid(),
			parent: parentId,
			role: MessageRole.SYSTEM,
			timestamp: Date.now(),
			type: MessageRole.SYSTEM
		};
		const [item] = await this.addItems(convId, [systemMessage]);

		return { ...systemMessage, version: item.version };
	}

	async deleteConversation(id: string, options?: { deleteWithForks?: boolean }): Promise<void> {
		const forks = options?.deleteWithForks ? 'delete' : 'keep';

		await this.enqueue(id, async () => {
			let deletedIds = [id];

			try {
				const deleted = await request(() =>
					apiDelete<ApiConversationDeleted>(conversationPath(id), { forks }, this.auth)
				);

				deletedIds = deleted.deleted_ids;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}

			this.forgetConversations(deletedIds);
		});
	}

	async deleteGroup(id: string): Promise<void> {
		await this.enqueue(id, async () => {
			try {
				await request(() => apiDelete(groupPath(id), undefined, this.auth));
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		});

		for (const conversation of this.conversations.values()) {
			if (conversation.groupId !== id) continue;

			delete conversation.groupId;
			this.markWritten(conversation.id);
		}
	}

	async deleteMessage(messageId: string): Promise<void> {
		const item = this.items.get(messageId);

		if (!item) return;

		await this.deleteItem(item.convId, messageId, false);
	}

	async deleteMessageCascading(conversationId: string, messageId: string): Promise<string[]> {
		return this.deleteItem(conversationId, messageId, true);
	}

	/** Resolves once every write already sent has settled. */
	async flush(): Promise<void> {
		while (this.queues.size > 0) {
			await Promise.all(this.queues.values());
		}
	}

	async forkConversation(
		sourceConvId: string,
		atMessageId: string,
		options: { name: string; includeAttachments: boolean }
	): Promise<DatabaseConversation> {
		const source = await this.knownConversation(sourceConvId);

		if (!source) {
			throw new Error(`Source conversation ${sourceConvId} not found`);
		}

		const body: Body = {
			...toConversationPatch(withoutUndefined({ cwd: source.cwd, groupId: source.groupId })),
			fork_from: {
				conversation_id: sourceConvId,
				include_attachments: options.includeAttachments,
				item_id: atMessageId
			},
			id: uuid(),
			name: options.name
		};

		// queued on the source so its pending writes land before the server copies its items
		return this.enqueue(sourceConvId, async () =>
			this.trackWrite(
				await request(() =>
					apiPost<ApiConversation>(API_CONVERSATIONS.CONVERSATIONS, body, this.auth)
				)
			)
		);
	}

	async getAllConversations(): Promise<DatabaseConversation[]> {
		await this.flush();

		const since = this.writes;
		const list = await request(() =>
			apiFetch<ApiList<ApiConversation>>(API_CONVERSATIONS.CONVERSATIONS, this.auth)
		);

		return list.data.map((record) => this.trackRead(record, since));
	}

	async getAllGroups(): Promise<Group[]> {
		const list = await request(() =>
			apiFetch<ApiList<ApiConversationGroup>>(API_CONVERSATIONS.GROUPS, this.auth)
		);

		return list.data.map(toGroup);
	}

	async getConversation(id: string): Promise<DatabaseConversation | undefined> {
		await this.queues.get(id);

		const since = this.writes;

		try {
			return this.trackRead(
				await request(() => apiFetch<ApiConversation>(conversationPath(id), this.auth)),
				since
			);
		} catch (error) {
			if (!isMissing(error)) throw error;

			if (this.isUnwrittenSince(id, since)) this.conversations.delete(id);

			return undefined;
		}
	}

	async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
		await this.queues.get(convId);

		let list: ApiList<ApiConversationItem>;

		try {
			list = await request(() =>
				apiFetch<ApiList<ApiConversationItem>>(`${itemsPath(convId)}?branches=all`, this.auth)
			);
		} catch (error) {
			if (!isMissing(error)) throw error;

			return [];
		}

		for (const item of list.data) {
			this.items.set(item.id, { convId, role: item.role });
		}

		return list.data
			.map((item) => toMessage(convId, item))
			.sort((a, b) => a.timestamp - b.timestamp);
	}

	async getConversationsWithMessages(
		convIds: string[]
	): Promise<Map<string, ExportedConversation>> {
		const result = new Map<string, ExportedConversation>();
		const cleanIds = convIds.filter((id): id is string => typeof id === 'string' && id.length > 0);

		if (cleanIds.length === 0) return result;

		const conversations = new Map(
			(await this.getAllConversations()).map((conv) => [conv.id, conv])
		);
		const found = cleanIds
			.map((id) => conversations.get(id))
			.filter((conv): conv is DatabaseConversation => conv !== undefined);
		const messages = await Promise.all(found.map((conv) => this.getConversationMessages(conv.id)));

		found.forEach((conv, i) => result.set(conv.id, { conv, messages: messages[i] }));

		return result;
	}

	async importConversations(): Promise<{
		imported: DatabaseConversation[];
		skipped: DatabaseConversation[];
	}> {
		throw new Error(ERROR_MESSAGES.CHAT_STORAGE.IMPORT_UNAVAILABLE);
	}

	async setConversationsGroup(ids: string[], groupId: string | null): Promise<void> {
		// joining a group unpins, as in this browser's database
		await Promise.all(
			ids.map((id) =>
				this.updateConversation(id, groupId ? { groupId, pinned: false } : { groupId: undefined })
			)
		);
	}

	async toggleConversationPin(id: string): Promise<boolean> {
		const conversation = await this.knownConversation(id);

		if (!conversation) {
			throw new Error(`Conversation ${id} not found`);
		}

		const pinned = !conversation.pinned;

		await this.updateConversation(id, { pinned });

		return pinned;
	}

	async updateConversation(
		id: string,
		updates: Partial<Omit<DatabaseConversation, 'id'>>,
		options?: ChatStoreWriteOptions
	): Promise<void> {
		const patch = toConversationPatch(updates);

		if (Object.keys(patch).length === 0) return;

		if (options?.ifVersion !== undefined) patch.if_version = options.ifVersion;

		await this.enqueue(id, async () => {
			const record = await request(() =>
				apiPost<ApiConversation>(conversationPath(id), patch, this.auth)
			);

			// only a name change moves a chat's version; other writes answer with whatever version it has
			if ('name' in patch) this.trackWrite(record);
			else this.track(record);
		});
	}

	async updateCurrentNode(convId: string, nodeId: string): Promise<void> {
		await this.updateConversation(convId, { currNode: nodeId });
	}

	async updateGroup(id: string, updates: Partial<Omit<Group, 'id'>>): Promise<void> {
		// the server stamps updated_at_ms itself
		if (updates.name === undefined) return;

		const body = { name: updates.name };

		await this.enqueue(id, async () => {
			await request(() => apiPost<ApiConversationGroup>(groupPath(id), body, this.auth));
		});
	}

	async updateMessage(
		id: string,
		updates: Partial<Omit<DatabaseMessage, 'id'>>,
		options?: ChatStoreWriteOptions
	): Promise<void> {
		const item = this.items.get(id);

		if (!item) {
			throw new Error(`Message ${id} not found`);
		}

		const patch = toItemPatch(item.role, updates);

		if (Object.keys(patch).length === 0) return;

		if (options?.ifVersion !== undefined) patch.if_version = options.ifVersion;

		await this.enqueue(item.convId, async () => {
			const updated = await request(() =>
				apiPost<ApiConversationItem>(itemPath(item.convId, id), patch, this.auth)
			);

			this.trackVersion(id, updated.version);
		});
	}

	async versionForEdit(record: { id: string; version?: number }): Promise<number | undefined> {
		// a write still on its way when the edit begins counts as seen by this window
		await this.queues.get(this.items.get(record.id)?.convId ?? record.id);

		const own = this.versions.get(record.id);

		if (record.version === undefined) return own ? Math.max(...own) : undefined;

		// an own write moves the start on only when no other window wrote before it, else the save gets stale_version
		let version = record.version;

		while (own?.has(version + 1)) version++;

		return version;
	}

	/**
	 * Reads Pico Server's change notices until `signal` aborts, and hands
	 * `onEvent` the ones other windows caused. A dropped stream reconnects
	 * with backoff. The server replays nothing, so `onOpen` runs each time a
	 * stream opens, the first one too: a change made before it is never
	 * notified. The stream goes out as this store's account.
	 */
	async watchEvents(
		signal: AbortSignal,
		onEvent: (event: ApiConversationEvent) => void,
		onOpen: () => void
	): Promise<void> {
		let delay: number = CONVERSATION_EVENTS.INITIAL_RECONNECT_DELAY_MS;

		while (!signal.aborted) {
			try {
				const response = await fetch(`${base}${API_CONVERSATIONS.EVENTS}`, {
					headers: this.auth.headers,
					signal
				});

				if (response.ok && response.body) {
					const reader = response.body.getReader();
					const decoder = new TextDecoder();

					let buffer = '';

					delay = CONVERSATION_EVENTS.INITIAL_RECONNECT_DELAY_MS;
					onOpen();

					while (!signal.aborted) {
						const { done, value } = await reader.read();

						if (done) break;

						buffer += decoder.decode(value, { stream: true });

						const { records, rest } = splitSseRecords(buffer);

						buffer = rest;

						for (const record of records) {
							const event = parseEvent(record);

							if (event && event.data.origin_client_id !== CLIENT_ID) onEvent(event);
						}
					}
				}
			} catch {
				// network drop or abort falls through to the reconnect delay
			}

			if (signal.aborted) return;

			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(
				delay * CONVERSATION_EVENTS.BACKOFF_MULTIPLIER,
				CONVERSATION_EVENTS.MAX_RECONNECT_DELAY_MS
			);
		}
	}

	private async addItems(
		convId: string,
		messages: DatabaseMessage[],
		currentItemId?: string
	): Promise<ApiConversationItem[]> {
		const body: Body = { items: messages.map(toItemInput) };

		if (currentItemId) body.current_item_id = currentItemId;

		const list = await this.enqueue(convId, () =>
			request(() => apiPost<ApiList<ApiConversationItem>>(itemsPath(convId), body, this.auth))
		);

		for (const item of list.data) {
			this.items.set(item.id, { convId, role: item.role });
			this.trackVersion(item.id, item.version);
		}

		return list.data;
	}

	private async deleteItem(convId: string, itemId: string, cascade: boolean): Promise<string[]> {
		return this.enqueue(convId, async () => {
			let deletedIds = [itemId];

			try {
				const deleted = await request(() =>
					apiDelete<ApiConversation & { deleted_ids: string[] }>(
						itemPath(convId, itemId),
						cascade ? { cascade: 'true' } : undefined,
						this.auth
					)
				);

				this.track(deleted);
				deletedIds = deleted.deleted_ids;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}

			for (const id of deletedIds) this.items.delete(id);

			return deletedIds;
		});
	}

	/**
	 * Runs `write` after every write already queued under `key`. A failed write
	 * rejects its own promise only; the queue goes on with the next one.
	 */
	private enqueue<T>(key: string, write: () => Promise<T>): Promise<T> {
		const run = (this.queues.get(key) ?? Promise.resolve()).then(write);
		const tail = run.then(
			() => undefined,
			() => undefined
		);

		this.queues.set(key, tail);
		void tail.then(() => {
			if (this.queues.get(key) === tail) this.queues.delete(key);
		});

		return run;
	}

	private forgetConversations(ids: string[]): void {
		const gone = new Set(ids);

		for (const id of gone) {
			this.conversations.delete(id);
			this.markWritten(id);
		}

		for (const [id, item] of this.items) {
			if (gone.has(item.convId)) this.items.delete(id);
		}
	}

	/** Whether no write to the chat finished after `since`, a {@link writes} count. */
	private isUnwrittenSince(id: string, since: number): boolean {
		return (this.written.get(id) ?? 0) <= since;
	}

	private async knownConversation(id: string): Promise<DatabaseConversation | undefined> {
		return this.conversations.get(id) ?? (await this.getConversation(id));
	}

	private markWritten(id: string): void {
		this.written.set(id, ++this.writes);
	}

	/** Maps the answer to this window's own write to a chat and keeps a copy for later forks and pin toggles. */
	private track(record: ApiConversation): DatabaseConversation {
		const conversation = toConversation(record);

		this.conversations.set(conversation.id, { ...conversation });
		this.markWritten(conversation.id);

		return conversation;
	}

	/**
	 * {@link track} for a chat record a read began to fetch at `since`, a
	 * {@link writes} count. A write to the chat that finished meanwhile keeps
	 * its newer copy: the server may have read before that write landed.
	 */
	private trackRead(record: ApiConversation, since: number): DatabaseConversation {
		const conversation = toConversation(record);

		if (this.isUnwrittenSince(conversation.id, since)) {
			this.conversations.set(conversation.id, { ...conversation });
		}

		return conversation;
	}

	/** Keeps the version the server gave this window's own write to a record. */
	private trackVersion(id: string, version: number): void {
		const own = this.versions.get(id) ?? new Set<number>();

		own.add(version);
		this.versions.set(id, own);
	}

	/** {@link track} for the answer to this window's own create or rename, whose version a later rename starts from. */
	private trackWrite(record: ApiConversation): DatabaseConversation {
		this.trackVersion(record.id, record.version);

		return this.track(record);
	}
}
