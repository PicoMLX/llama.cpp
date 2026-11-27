import { PICO_MCP } from '$lib/constants/mcp.constants';
import type { ApiChatCompletionToolCall } from '$lib/types/api';
import type {
	ResponsesMcpApprovalRequestItem,
	ResponsesMcpCallError,
	ResponsesMcpCallItem,
	ResponsesMcpItem
} from '$lib/types/pico-tools';

const MCP_ITEM_TYPES: ReadonlySet<string> = new Set([
	'mcp_approval_request',
	'mcp_approval_response',
	'mcp_call',
	'mcp_list_tools'
]);

/** Absolute URL of Pico's own `/mcp`, next to the page like the other API paths. */
export function picoMcpUrl(): string {
	return new URL(PICO_MCP.PATH, globalThis.location?.href ?? 'http://localhost/').href;
}

/** True for a URL of Pico's own `/mcp`, on this page's origin. */
export function isPicoMcpUrl(url: string): boolean {
	const trim = (href: string) => href.replace(/\/+$/, '');

	try {
		return trim(new URL(url, picoMcpUrl()).href) === trim(picoMcpUrl());
	} catch {
		return false;
	}
}

export function isMcpItem(value: unknown): value is ResponsesMcpItem {
	return (
		typeof value === 'object' &&
		value !== null &&
		MCP_ITEM_TYPES.has(String((value as { type?: unknown }).type))
	);
}

/**
 * An assistant message stores Pico's MCP items next to its function calls in `toolCalls`, the one field every chat store keeps as given.
 * Readers split them here, so function calls never see MCP items.
 */
export function splitStoredToolCalls(value: unknown): {
	toolCalls: ApiChatCompletionToolCall[];
	mcpItems: ResponsesMcpItem[];
} {
	let list: unknown = value;

	if (typeof value === 'string') {
		try {
			list = value.trim() ? JSON.parse(value) : [];
		} catch {
			list = [];
		}
	}

	const toolCalls: ApiChatCompletionToolCall[] = [];
	const mcpItems: ResponsesMcpItem[] = [];

	if (!Array.isArray(list)) return { mcpItems, toolCalls };

	for (const entry of list) {
		if (isMcpItem(entry)) mcpItems.push(entry);
		else if (entry && typeof entry === 'object') toolCalls.push(entry as ApiChatCompletionToolCall);
	}

	return { mcpItems, toolCalls };
}

export function serializeStoredToolCalls(
	toolCalls: ApiChatCompletionToolCall[] | undefined,
	mcpItems: ResponsesMcpItem[] | undefined
): string {
	const all = [...(toolCalls ?? []), ...(mcpItems ?? [])];

	return all.length > 0 ? JSON.stringify(all) : '';
}

/** Approval requests that no `mcp_approval_response` answers yet, in order. */
export function unansweredApprovalRequests(
	items: readonly ResponsesMcpItem[]
): ResponsesMcpApprovalRequestItem[] {
	const answered = new Set(
		items.flatMap((item) =>
			item.type === 'mcp_approval_response' ? [item.approval_request_id] : []
		)
	);

	return items.filter(
		(item): item is ResponsesMcpApprovalRequestItem =>
			item.type === 'mcp_approval_request' && !answered.has(item.id)
	);
}

/** True while Pico has not reported the call's result. */
export function isMcpCallRunning(item: ResponsesMcpCallItem): boolean {
	if (item.status === 'in_progress' || item.status === 'calling') return true;

	return !item.status && item.output == null && item.error == null;
}

/** Error text of an `mcp_call`, from OpenAI's error object or a plain string. */
export function mcpCallErrorText(error: ResponsesMcpCallError | null | undefined): string | null {
	if (error == null) return null;

	if (typeof error === 'string') return error || null;

	if ('message' in error && error.message) return error.message;

	if ('content' in error && error.content != null) {
		return typeof error.content === 'string' ? error.content : JSON.stringify(error.content);
	}

	return error.type;
}

/**
 * The message text cut where Pico's items appeared, so history and the UI keep the model's order.
 * Each run is the text before a group of items and those items; a last run without items holds the trailing text.
 * Items without an offset belong after the text.
 */
export function mcpItemRuns(
	content: string,
	items: readonly ResponsesMcpItem[]
): Array<{ text: string; items: ResponsesMcpItem[] }> {
	const offsetOf = (item: ResponsesMcpItem) =>
		Math.min(Math.max(item.content_offset ?? content.length, 0), content.length);
	const sorted = items
		.map((item, index) => ({ index, item, offset: offsetOf(item) }))
		.sort((a, b) => a.offset - b.offset || a.index - b.index);
	const runs: Array<{ text: string; items: ResponsesMcpItem[] }> = [];

	let position = 0;

	for (const { item, offset } of sorted) {
		const last = runs[runs.length - 1];

		if (last && offset === position && last.items.length > 0) {
			last.items.push(item);

			continue;
		}

		runs.push({ items: [item], text: content.slice(position, offset) });
		position = offset;
	}

	if (position < content.length || runs.length === 0) {
		runs.push({ items: [], text: content.slice(position) });
	}

	return runs;
}
