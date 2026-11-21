// In-memory Pico Server for the conversations API contract, served through a
// fetch mock. One account; ids, versions, stale edits, moves, forks and the
// tree rules follow the contract so the web UI's server store can be tested
// without PicoServer.

import type {
	ApiConversation,
	ApiConversationGroup,
	ApiConversationItem,
	ApiList
} from '$lib/types/api';

type Body = Record<string, unknown>;

export interface MockRequest {
	body: Body | null;
	headers: Headers;
	method: string;
	path: string;
	search: URLSearchParams;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ITEM_FIELDS = [
	'content',
	'parent_id',
	'timestamp_ms',
	'model',
	'is_synthetic',
	'reasoning_content',
	'tool_calls',
	'tool_call_id',
	'tool_cwd',
	'completion_id',
	'kept',
	'timings',
	'attachments'
];

class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		public current?: unknown
	) {
		super(code);
	}
}

function list<T extends { id: string }>(data: T[]): ApiList<T> {
	return {
		data,
		first_id: data[0]?.id ?? null,
		has_more: false,
		last_id: data[data.length - 1]?.id ?? null,
		object: 'list'
	};
}

function checkId(id: unknown): string {
	if (typeof id !== 'string' || !UUID_V4.test(id)) throw new HttpError(400, 'invalid_id');

	return id;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

export class MockConversationsServer {
	conversations = new Map<string, ApiConversation>();
	/** The fetch implementation to install with vi.spyOn(globalThis, 'fetch'). */
	fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, 'http://pico.test');
		const text = typeof init?.body === 'string' ? init.body : null;
		const request: MockRequest = {
			body: text ? (JSON.parse(text) as Body) : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? 'GET',
			path: url.pathname,
			search: url.searchParams
		};

		await this.gate?.(request);
		this.requests.push(request);

		try {
			return this.json(200, this.route(request));
		} catch (error) {
			if (!(error instanceof HttpError)) throw error;

			return this.json(error.status, {
				...(error.current ? { current: error.current } : {}),
				error: { code: error.code, message: error.code, param: null, type: 'invalid_request_error' }
			});
		}
	};
	/** Awaited before a request is handled, to hold it back. */
	gate: ((request: MockRequest) => Promise<void> | void) | null = null;
	groups = new Map<string, ApiConversationGroup>();
	/** Items of each conversation, by item id. */
	items = new Map<string, Map<string, Omit<ApiConversationItem, 'children_ids'>>>();
	/** Server clock; tests set it to get known timestamps. */
	now = 1_000;

	/** Every request the server answered, in arrival order. */
	requests: MockRequest[] = [];

	private serverIds = 0;

	/** Changes an item as another window would. */
	editElsewhere(convId: string, itemId: string, text: string): void {
		const item = this.items.get(convId)?.get(itemId);

		if (!item) throw new Error(`no item ${itemId}`);

		item.content = [{ text, type: 'input_text' }];
		item.version++;
	}

	/** Writes the requests sent so far, as `METHOD path`. */
	log(filter: (request: MockRequest) => boolean = () => true): string[] {
		return this.requests.filter(filter).map((r) => `${r.method} ${r.path}`);
	}

	private addItems(convId: string, body: Body) {
		const conversation = this.conversation(convId);
		const items = this.items.get(convId)!;
		const inputs = body.items as Body[];
		const created: Omit<ApiConversationItem, 'children_ids'>[] = [];

		for (const input of inputs) {
			const id = checkId(input.id);
			const existing = items.get(id);

			if (existing) {
				created.push(existing);

				continue;
			}

			if ('children_ids' in input) throw new HttpError(400, 'invalid_request');

			const parent = input.parent_id as string | null;
			const hasRoot = [...items.values()].some((item) => item.parent_id === null);

			if (parent === null ? hasRoot || input.message_type !== 'root' : !items.has(parent)) {
				throw new HttpError(400, 'invalid_parent');
			}

			const item = {
				...clone(input),
				status: 'completed',
				type: 'message',
				version: 1
			} as unknown as Omit<ApiConversationItem, 'children_ids'>;

			items.set(id, item);
			created.push(item);
		}

		if (body.current_item_id !== undefined) {
			conversation.current_item_id = body.current_item_id as string | null;
		}

		conversation.last_modified_ms = this.now;

		return list(created.map((item) => this.viewItem(convId, item)));
	}

	private checkVersion(record: { version: number }, body: Body): void {
		if (body.if_version !== undefined && body.if_version !== record.version) {
			throw new HttpError(409, 'stale_version', clone(record));
		}
	}

	private childrenOf(convId: string, itemId: string): string[] {
		return [...(this.items.get(convId)?.values() ?? [])]
			.filter((item) => item.parent_id === itemId)
			.sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.id.localeCompare(b.id))
			.map((item) => item.id);
	}

	private conversation(id: string): ApiConversation {
		const conversation = this.conversations.get(id);

		if (!conversation) throw new HttpError(404, 'not_found');

		return conversation;
	}

	private createConversation(body: Body): ApiConversation {
		const id = checkId(body.id);
		const existing = this.conversations.get(id);

		if (existing) return existing;

		const groupId = (body.group_id as string | null | undefined) ?? null;

		if (groupId && !this.groups.has(groupId)) throw new HttpError(400, 'invalid_request');

		const conversation: ApiConversation = {
			created_at: Math.floor(this.now / 1000),
			current_item_id: null,
			forked_from_conversation_id: null,
			group_id: groupId,
			id,
			last_modified_ms: this.now,
			metadata: (body.metadata as Record<string, string>) ?? {},
			name: body.name as string,
			object: 'conversation',
			pinned: Boolean(body.pinned),
			settings: this.patchSettings({}, body.settings as Body | undefined),
			version: 1
		};
		const items = new Map<string, Omit<ApiConversationItem, 'children_ids'>>();
		const fork = body.fork_from as
			| { conversation_id: string; include_attachments: boolean; item_id: string }
			| undefined;

		if (fork) {
			const source = this.items.get(this.conversation(fork.conversation_id).id)!;
			const path: Omit<ApiConversationItem, 'children_ids'>[] = [];

			for (
				let at = source.get(fork.item_id);
				at;
				at = at.parent_id ? source.get(at.parent_id) : undefined
			) {
				path.unshift(at);
			}

			if (path.length === 0) throw new HttpError(400, 'invalid_parent');

			const newIds = new Map(path.map((item) => [item.id, this.serverId()]));

			for (const item of path) {
				const copy = clone(item);

				copy.id = newIds.get(item.id)!;
				copy.parent_id = item.parent_id ? newIds.get(item.parent_id)! : null;
				copy.version = 1;

				if (!fork.include_attachments) delete copy.attachments;

				items.set(copy.id, copy);
			}

			conversation.forked_from_conversation_id = fork.conversation_id;
			conversation.current_item_id = newIds.get(fork.item_id)!;
		}

		this.conversations.set(id, conversation);
		this.items.set(id, items);

		return conversation;
	}

	private deleteConversation(id: string, forks: string): string[] {
		const conversation = this.conversation(id);
		const deleted = [id];

		for (const other of this.conversations.values()) {
			if (other.forked_from_conversation_id !== id) continue;

			if (forks === 'delete') deleted.push(...this.deleteConversation(other.id, forks));
			else other.forked_from_conversation_id = conversation.forked_from_conversation_id;
		}

		this.conversations.delete(id);
		this.items.delete(id);

		return deleted;
	}

	private deleteItem(convId: string, itemId: string, cascade: boolean) {
		const conversation = this.conversation(convId);
		const items = this.items.get(convId)!;
		const item = items.get(itemId);

		if (!item) throw new HttpError(404, 'not_found');

		if (!cascade && this.childrenOf(convId, itemId).length > 0) {
			throw new HttpError(409, 'has_children');
		}

		const deleted: string[] = [];
		const queue = [itemId];

		while (queue.length > 0) {
			const id = queue.shift()!;

			deleted.push(id);
			queue.push(...this.childrenOf(convId, id));
		}

		for (const id of deleted) items.delete(id);

		if (conversation.current_item_id && deleted.includes(conversation.current_item_id)) {
			conversation.current_item_id = item.parent_id;
		}

		return { ...this.view(conversation), deleted_ids: deleted };
	}

	private json(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), {
			headers: { 'Content-Type': 'application/json' },
			status
		});
	}

	private patchSettings(settings: Body, patch: Body | undefined): Body {
		const next = { ...settings };

		for (const [key, value] of Object.entries(patch ?? {})) {
			if (value === null) delete next[key];
			else next[key] = value;
		}

		return next;
	}

	private route(request: MockRequest): unknown {
		const { body, method, path, search } = request;
		const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

		if (parts[0] !== 'v1') throw new HttpError(404, 'not_found');

		if (parts[1] === 'conversation_groups') {
			const [, , id] = parts;

			if (!id && method === 'GET') {
				return list([...this.groups.values()].sort((a, b) => b.created_at_ms - a.created_at_ms));
			}

			if (!id && method === 'POST') {
				const groupId = checkId(body!.id);
				const existing = this.groups.get(groupId);

				if (existing) return existing;

				const group: ApiConversationGroup = {
					created_at_ms: this.now,
					id: groupId,
					name: body!.name as string,
					object: 'conversation_group',
					updated_at_ms: this.now,
					version: 1
				};

				this.groups.set(groupId, group);

				return group;
			}

			const group = this.groups.get(id);

			if (!group) throw new HttpError(404, 'not_found');

			if (method === 'POST') {
				this.checkVersion(group, body!);

				if (body!.name !== group.name) group.version++;

				group.name = body!.name as string;
				group.updated_at_ms = this.now;

				return group;
			}

			if (method === 'DELETE') {
				this.groups.delete(id);

				for (const conversation of this.conversations.values()) {
					if (conversation.group_id === id) conversation.group_id = null;
				}

				return { deleted: true, id, object: 'conversation_group.deleted' };
			}
		}

		if (parts[1] !== 'conversations') throw new HttpError(404, 'not_found');

		const [, , convId, sub, itemId] = parts;

		if (!convId && method === 'GET') {
			return list(
				[...this.conversations.values()]
					.sort((a, b) => b.last_modified_ms - a.last_modified_ms)
					.map((conversation) => this.view(conversation))
			);
		}

		if (!convId && method === 'POST') return this.view(this.createConversation(body!));

		if (!sub) {
			const conversation = this.conversation(convId);

			if (method === 'GET') return this.view(conversation);

			if (method === 'POST') return this.view(this.updateConversation(conversation, body!));

			if (method === 'DELETE') {
				const deleted = this.deleteConversation(convId, search.get('forks') ?? 'keep');

				return { deleted: true, deleted_ids: deleted, id: convId, object: 'conversation.deleted' };
			}
		}

		if (sub === 'items') {
			this.conversation(convId);

			if (!itemId && method === 'GET') {
				if (search.get('branches') !== 'all') throw new HttpError(400, 'unsupported_parameter');

				return list(
					[...this.items.get(convId)!.values()]
						.sort((a, b) => a.timestamp_ms - b.timestamp_ms)
						.map((item) => this.viewItem(convId, item))
				);
			}

			if (!itemId && method === 'POST') return this.addItems(convId, body!);

			const item = this.items.get(convId)!.get(itemId);

			if (!item) throw new HttpError(404, 'not_found');

			if (method === 'GET') return this.viewItem(convId, item);

			if (method === 'POST') return this.viewItem(convId, this.updateItem(convId, item, body!));

			if (method === 'DELETE') {
				return this.deleteItem(convId, itemId, search.get('cascade') === 'true');
			}
		}

		throw new HttpError(404, 'not_found');
	}

	private serverId(): string {
		const n = (++this.serverIds).toString(16).padStart(12, '0');

		return `00000000-0000-4000-8000-${n}`;
	}

	private updateConversation(conversation: ApiConversation, body: Body): ApiConversation {
		this.checkVersion(conversation, body);

		if (typeof body.name === 'string' && body.name !== conversation.name) {
			conversation.name = body.name;
			conversation.version++;
		}

		if (body.pinned !== undefined) conversation.pinned = Boolean(body.pinned);

		if (body.group_id !== undefined) {
			if (body.group_id && !this.groups.has(body.group_id as string)) {
				throw new HttpError(400, 'invalid_request');
			}

			conversation.group_id = body.group_id as string | null;
		}

		if (body.current_item_id !== undefined) {
			conversation.current_item_id = body.current_item_id as string | null;
		}

		if (body.settings !== undefined) {
			conversation.settings = this.patchSettings(conversation.settings, body.settings as Body);
		}

		return conversation;
	}

	private updateItem(
		convId: string,
		item: Omit<ApiConversationItem, 'children_ids'>,
		body: Body
	): Omit<ApiConversationItem, 'children_ids'> {
		if ('children_ids' in body || 'id' in body || 'role' in body || 'message_type' in body) {
			throw new HttpError(400, 'invalid_request');
		}

		this.checkVersion(item, body);

		if (body.parent_id !== undefined) {
			const parent = body.parent_id as string | null;
			const items = this.items.get(convId)!;

			if (item.parent_id === null || parent === null || !items.has(parent)) {
				throw new HttpError(400, 'invalid_parent');
			}

			for (
				let at = items.get(parent);
				at;
				at = at.parent_id ? items.get(at.parent_id) : undefined
			) {
				if (at.id === item.id) throw new HttpError(400, 'invalid_parent');
			}
		}

		const fields = item as unknown as Body;

		for (const field of ITEM_FIELDS) {
			if (!(field in body)) continue;

			if (body[field] === null) delete fields[field];
			else fields[field] = clone(body[field]);
		}

		item.version++;

		return item;
	}

	private view(conversation: ApiConversation): ApiConversation {
		return clone(conversation);
	}

	private viewItem(
		convId: string,
		item: Omit<ApiConversationItem, 'children_ids'>
	): ApiConversationItem {
		return { ...clone(item), children_ids: this.childrenOf(convId, item.id) };
	}
}
