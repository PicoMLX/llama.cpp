import { MessageRole, MessageType, ToolPermissionDecision, ToolSource } from '$lib/enums';
import { MCPService } from '$lib/services/mcp.service';
import { OpenResponsesService } from '$lib/services/open-responses';
import { ToolsService } from '$lib/services/tools.service';
import { AgenticGates } from '$lib/stores/agentic/gates.svelte';
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import type {
	ApiLlamaCppServerProps,
	DatabaseMessage,
	MCPConnection,
	PicoToolInfo,
	ResponsesMcpItem
} from '$lib/types';
import {
	isPicoMcpUrl,
	mcpCallErrorText,
	mcpItemRuns,
	serializeStoredToolCalls,
	splitStoredToolCalls,
	unansweredApprovalRequests
} from '$lib/utils/pico-tools';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Streams mirror OpenAI's documented Responses MCP items and events (openai npm SDK 7.65.0, resources/responses/responses.d.ts).
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-responses');
const fixture = (name: string) => readFileSync(resolve(fixturesDir, name), 'utf8');
const PICO_ORIGIN = 'http://pico.local:8080/';
const listItem: ResponsesMcpItem = {
	id: 'mcpl_1',
	server_label: 'pico',
	tools: [{ input_schema: { type: 'object' }, name: 'weather_current' }],
	type: 'mcp_list_tools'
};
const weatherCall: ResponsesMcpItem = {
	approval_request_id: null,
	arguments: '{"location":"Amsterdam"}',
	error: null,
	id: 'mcp_1',
	name: 'weather_current',
	output: '{"temperature_c":12}',
	server_label: 'pico',
	status: 'completed',
	type: 'mcp_call'
};
const reminderRequest: ResponsesMcpItem = {
	arguments: '{"title":"Buy milk"}',
	id: 'mcpr_1',
	name: 'reminders_create',
	server_label: 'pico',
	type: 'mcp_approval_request'
};
const picoTools: PicoToolInfo[] = [
	{ approvalRequired: false, name: 'weather_current', title: 'Current Weather' },
	{ approvalRequired: true, name: 'reminders_create', title: 'Create Reminder' },
	{ approvalRequired: true, name: 'files_write', title: 'Write File' }
];

function streamResponse(body: string): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			}
		}),
		{ status: 200 }
	);
}

function storedAssistant(content: string, items: unknown[]): DatabaseMessage {
	return {
		children: [],
		content,
		convId: 'conv-1',
		id: 'assistant-1',
		parent: null,
		role: MessageRole.ASSISTANT,
		timestamp: 0,
		toolCalls: JSON.stringify(items),
		type: MessageType.TEXT
	};
}

function usePicoServer(): void {
	serverStore.props = { server_name: 'Pico AI Server' } as ApiLlamaCppServerProps;
}

beforeEach(() => {
	const storage = new Map<string, string>();

	vi.stubGlobal('location', new URL(PICO_ORIGIN));
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		removeItem: (key: string) => storage.delete(key),
		setItem: (key: string, value: string) => storage.set(key, value)
	});
});

afterEach(() => {
	serverStore.props = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('Pico MCP stream items', () => {
	it('reports a streamed mcp_call live, then with its result, in text order', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(streamResponse(fixture('openai-mcp-call.sse')))
		);

		const snapshots: ResponsesMcpItem[][] = [];
		const onComplete = vi.fn();

		await OpenResponsesService.sendMessage([{ content: 'Weather?', role: 'user' }], {
			onComplete,
			onMcpItems: (items: ResponsesMcpItem[]) => snapshots.push(items),
			stream: true
		});

		const live = snapshots.find((items) =>
			items.some((item) => item.type === 'mcp_call' && item.arguments === '{"location":')
		);

		expect(live?.find((item) => item.type === 'mcp_call')).toMatchObject({
			arguments: '{"location":',
			status: 'in_progress'
		});

		const final = snapshots.at(-1)!;

		expect(final.map((item) => item.type)).toEqual(['mcp_list_tools', 'mcp_call']);
		expect(final[0]).toMatchObject({ content_offset: 0, tools: [{ name: 'weather_current' }] });
		expect(final[1]).toEqual({
			approval_request_id: null,
			arguments: '{"location":"Amsterdam"}',
			content_offset: 'Let me check.'.length,
			error: null,
			id: 'mcp_1',
			name: 'weather_current',
			output: '{"temperature_c":12,"condition":"Cloudy"}',
			server_label: 'pico',
			status: 'completed',
			type: 'mcp_call'
		});

		const [content, , , toolCalls, finishReason] = onComplete.mock.calls[0];

		expect(content).toBe('Let me check.It is 12 C and cloudy.');
		expect(toolCalls).toBeUndefined();
		expect(finishReason).toBe('stop');
	});

	it('ends the response on an unanswered mcp_approval_request', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(streamResponse(fixture('openai-mcp-approval.sse')))
		);

		let items: ResponsesMcpItem[] = [];

		const onComplete = vi.fn();

		await OpenResponsesService.sendMessage([{ content: 'Remind me', role: 'user' }], {
			onComplete,
			onMcpItems: (next: ResponsesMcpItem[]) => (items = next),
			stream: true
		});

		expect(unansweredApprovalRequests(items)).toEqual([
			{ ...reminderRequest, content_offset: 'I will add that reminder.'.length }
		]);
		expect(onComplete.mock.calls[0][0]).toBe('I will add that reminder.');
	});

	it('reads mcp items from a non-stream response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						id: 'resp_1',
						output: [
							weatherCall,
							{ content: [{ text: 'Cloudy.', type: 'output_text' }], type: 'message' }
						],
						status: 'completed'
					}),
					{ status: 200 }
				)
			)
		);

		const onMcpItems = vi.fn();

		await OpenResponsesService.sendMessage([{ content: 'Weather?', role: 'user' }], {
			onMcpItems,
			stream: false
		});

		expect(onMcpItems).toHaveBeenCalledWith([{ ...weatherCall, content_offset: 0 }]);
	});
});

describe('Pico mcp tool entry', () => {
	it('sends the entry it is given next to the function tools', async () => {
		usePicoServer();
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(fixture('openai-mcp-call.sse')));

		vi.stubGlobal('fetch', fetchMock);

		const entry = {
			allowed_tools: ['weather_current', 'reminders_create'],
			require_approval: { never: { tool_names: ['weather_current'] } },
			server_label: 'pico',
			server_url: `${PICO_ORIGIN}mcp`,
			type: 'mcp' as const
		};

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			picoMcpTool: entry,
			tools: [
				{
					function: { name: 'get_datetime', parameters: { type: 'object' } },
					type: 'function'
				}
			]
		});

		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

		expect(body.tools).toEqual([
			{ name: 'get_datetime', parameters: { type: 'object' }, type: 'function' },
			entry
		]);
	});

	it('names no Pico tools in a request without an entry', async () => {
		usePicoServer();
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(fixture('openai-mcp-call.sse')));

		vi.stubGlobal('fetch', fetchMock);

		await OpenResponsesService.sendMessage([{ content: 'Title this chat', role: 'user' }], {});

		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

		expect(body.tools).toEqual([
			{ allowed_tools: [], server_label: 'pico', server_url: `${PICO_ORIGIN}mcp`, type: 'mcp' }
		]);
	});

	it('allows enabled tools and never asks for approval-free or always-allowed ones', async () => {
		usePicoServer();
		vi.spyOn(ToolsService, 'listPicoTools').mockResolvedValue(picoTools);
		await toolsStore.fetchPicoTools();
		permissionsStore.allowTool('pico:reminders_create');

		const entry = toolsStore.getPicoMcpTool(new Set(['pico:files_write']), new Set());

		permissionsStore.revokeTool('pico:reminders_create');

		expect(entry).toEqual({
			allowed_tools: ['weather_current', 'reminders_create'],
			require_approval: { never: { tool_names: ['weather_current', 'reminders_create'] } },
			server_label: 'pico',
			server_url: `${PICO_ORIGIN}mcp`,
			type: 'mcp'
		});
		expect(toolsStore.getPicoMcpTool(new Set(), new Set([ToolSource.PICO]))).toEqual({
			allowed_tools: [],
			server_label: 'pico',
			server_url: `${PICO_ORIGIN}mcp`,
			type: 'mcp'
		});
		expect(
			toolsStore
				.getEnabledToolsForLLM(new Set(), new Set())
				.map((tool) => tool.function.name)
				.filter((name) => picoTools.some((tool) => tool.name === name))
		).toEqual([]);
	});

	it('"Always allow all tools from Pico" keeps the key of a Pico tool named like a WebUI tool', async () => {
		usePicoServer();
		vi.spyOn(ToolsService, 'listPicoTools').mockResolvedValue([
			...picoTools,
			{ approvalRequired: true, name: 'get_datetime', title: 'Pico Time' }
		]);
		await toolsStore.fetchPicoTools();

		const gates = new AgenticGates();
		const decision = gates.requestPermission('conv-1', 'reminders_create', 'Pico', undefined, {
			permissionKey: 'pico:reminders_create'
		});

		gates.resolvePermission('conv-1', ToolPermissionDecision.ALWAYS_SERVER);
		await decision;

		expect(
			['pico:get_datetime', 'pico:reminders_create', 'browser:get_datetime'].map((key) =>
				permissionsStore.hasTool(key)
			)
		).toEqual([true, true, false]);

		for (const key of permissionsStore.tools) permissionsStore.revokeTool(key);
	});

	it("drops another caller's Pico tool list when listing for a new API key fails", async () => {
		usePicoServer();
		const previousKey = settingsStore.config.apiKey;
		const list = vi.spyOn(ToolsService, 'listPicoTools').mockResolvedValue(picoTools);

		settingsStore.config.apiKey = 'key-a';
		await toolsStore.fetchPicoTools();
		expect(toolsStore.hasListedPicoTools).toBe(true);

		settingsStore.config.apiKey = 'key-b';
		expect(toolsStore.hasListedPicoTools).toBe(false);
		list.mockRejectedValue(new Error('401'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await toolsStore.fetchPicoTools();

		expect(toolsStore.picoTools).toEqual([]);
		expect(toolsStore.needsPicoToolsListing).toBe(false);
		settingsStore.config.apiKey = previousKey;
	});

	it('fails a listing whose tools/list failed instead of listing no tools', async () => {
		usePicoServer();
		vi.spyOn(MCPService, 'connect').mockResolvedValue({
			client: { listTools: vi.fn().mockRejectedValue(new Error('tools/list failed')) },
			tools: []
		} as unknown as MCPConnection);
		vi.spyOn(MCPService, 'disconnect').mockResolvedValue();

		await expect(ToolsService.listPicoTools()).rejects.toThrow('tools/list failed');
	});

	it('lists Pico tools from /mcp with their title, icons and approval decision', async () => {
		usePicoServer();
		const icon = { mimeType: 'image/svg+xml', sizes: ['any'], src: 'data:image/svg+xml;base64,AA' };
		const connect = vi.spyOn(MCPService, 'connect').mockResolvedValue({
			tools: [
				{
					_meta: { 'pico/approval': 'none' },
					annotations: { readOnlyHint: true },
					icons: [icon],
					inputSchema: { type: 'object' },
					name: 'weather_current',
					title: 'Current Weather'
				},
				{
					_meta: { 'pico/approval': 'required' },
					inputSchema: { type: 'object' },
					name: 'reminders_create',
					title: 'Create Reminder'
				},
				{ inputSchema: { type: 'object' }, name: 'external_tool' }
			]
		} as unknown as MCPConnection);
		const disconnect = vi.spyOn(MCPService, 'disconnect').mockResolvedValue();
		const tools = await ToolsService.listPicoTools();

		expect(connect.mock.calls[0][1]).toMatchObject({
			transport: 'streamable_http',
			url: `${PICO_ORIGIN}mcp`
		});
		expect(disconnect).toHaveBeenCalledOnce();
		expect(tools).toEqual([
			{
				approvalRequired: false,
				icons: [icon],
				inputSchema: { type: 'object' },
				name: 'weather_current',
				readOnly: true,
				title: 'Current Weather'
			},
			{
				approvalRequired: true,
				inputSchema: { type: 'object' },
				name: 'reminders_create',
				title: 'Create Reminder'
			},
			{ approvalRequired: true, inputSchema: { type: 'object' }, name: 'external_tool' }
		]);
	});
});

describe('Pico mcp items in history', () => {
	it('sends stored items in model order, marks a cut-off call and denies an unanswered approval', () => {
		const running: ResponsesMcpItem = {
			arguments: '{}',
			id: 'mcp_9',
			name: 'weather_current',
			server_label: 'pico',
			status: 'in_progress',
			type: 'mcp_call'
		};
		const message = storedAssistant('Let me check.It is cloudy. Adding it.', [
			{ ...listItem, content_offset: 0 },
			{ ...weatherCall, content_offset: 13 },
			{ ...running, content_offset: 13 },
			{ ...reminderRequest, content_offset: 37 }
		]);

		expect(OpenResponsesService.convertMessagesToInput([message])).toEqual([
			listItem,
			{
				content: 'Let me check.',
				role: 'assistant',
				status: 'completed',
				type: 'message'
			},
			weatherCall,
			{
				...running,
				error: 'The call was interrupted before Pico reported its result.',
				status: 'failed'
			},
			{
				content: 'It is cloudy. Adding it.',
				role: 'assistant',
				status: 'completed',
				type: 'message'
			},
			reminderRequest,
			{ approval_request_id: 'mcpr_1', approve: false, type: 'mcp_approval_response' }
		]);
	});

	it('closes an earlier approval that no call carried out, and keeps the last turn pending', () => {
		const approved: ResponsesMcpItem = {
			approval_request_id: 'mcpr_1',
			approve: true,
			type: 'mcp_approval_response'
		};
		const declined: ResponsesMcpItem = { ...approved, approve: false };
		const closingCall = (error: string) => ({
			approval_request_id: 'mcpr_1',
			arguments: '{"title":"Buy milk"}',
			error,
			id: 'mcp_mcpr_1',
			name: 'reminders_create',
			output: null,
			server_label: 'pico',
			status: 'failed',
			type: 'mcp_call'
		});
		const paused = (response?: ResponsesMcpItem) => ({
			content: '',
			mcp_items: response ? [reminderRequest, response] : [reminderRequest],
			role: 'assistant' as const
		});
		const user = { content: 'Next', role: 'user' as const };

		// a denial the user gave, or the one sent for a request left unanswered
		for (const turn of [paused(declined), paused()]) {
			expect(OpenResponsesService.convertMessagesToInput([turn, user])).toEqual([
				reminderRequest,
				{ approval_request_id: 'mcpr_1', approve: false, type: 'mcp_approval_response' },
				closingCall('The user declined this tool call.'),
				user
			]);
		}

		// an approved call that never reported back
		expect(OpenResponsesService.convertMessagesToInput([paused(approved), user])).toEqual([
			reminderRequest,
			{ approval_request_id: 'mcpr_1', approve: true, type: 'mcp_approval_response' },
			closingCall('The call was interrupted before Pico reported its result.'),
			user
		]);

		// carried out by a later turn's call
		const carriedOut = OpenResponsesService.convertMessagesToInput([
			paused(approved),
			{
				content: 'Added.',
				mcp_items: [{ ...weatherCall, approval_request_id: 'mcpr_1', name: 'reminders_create' }],
				role: 'assistant'
			},
			user
		]);

		expect(carriedOut.filter((item) => (item as { id?: string }).id === 'mcp_mcpr_1')).toEqual([]);

		// the last turn, with only its client tool results after it, stays pending
		expect(
			OpenResponsesService.convertMessagesToInput([
				user,
				paused(declined),
				{ content: '2026-11-27', role: 'tool', tool_call_id: 'call_1' }
			]).some((item) => (item as { type?: string }).type === 'mcp_call')
		).toBe(false);
	});

	it('ends a paused turn on the approval request and its response', () => {
		const input = OpenResponsesService.convertMessagesToInput([
			{ content: 'Remind me', role: 'user' },
			{
				// a tool-only agentic turn has no content
				content: undefined as unknown as string,
				mcp_items: [
					{ ...reminderRequest, content_offset: 0 },
					{
						approval_request_id: 'mcpr_1',
						approve: true,
						content_offset: 0,
						type: 'mcp_approval_response'
					}
				],
				reasoning_content: 'This needs a reminder.',
				role: 'assistant'
			}
		]);

		expect(input).toEqual([
			{ content: 'Remind me', role: 'user' },
			{
				content: [{ text: 'This needs a reminder.', type: 'reasoning_text' }],
				summary: [],
				type: 'reasoning'
			},
			reminderRequest,
			{ approval_request_id: 'mcpr_1', approve: true, type: 'mcp_approval_response' }
		]);
	});

	it('keeps function calls and mcp items apart in stored tool calls', () => {
		const functionCall = {
			function: { arguments: '{}', name: 'get_datetime' },
			id: 'call_1',
			type: 'function'
		};
		const stored = serializeStoredToolCalls([functionCall], [weatherCall]);

		expect(splitStoredToolCalls(stored)).toEqual({
			mcpItems: [weatherCall],
			toolCalls: [functionCall]
		});
		expect(serializeStoredToolCalls(undefined, [])).toBe('');
		expect(splitStoredToolCalls('not json')).toEqual({ mcpItems: [], toolCalls: [] });
	});
});

// Pico Server's real output: PS-2's golden fixtures (ronaldmannak/PicoServer `claude/tools-phase2`, PicoServerTests/Fixtures/ResponsesSDK/responses-mcp-*-stream.txt)
describe("Pico Server's MCP streams", () => {
	async function parse(name: string) {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(fixture(name))));

		let items: ResponsesMcpItem[] = [];

		const onComplete = vi.fn();

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onComplete,
			onMcpItems: (next: ResponsesMcpItem[]) => (items = next),
			stream: true
		});

		const [content, , , toolCalls] = onComplete.mock.calls[0];

		return { content, items, toolCalls: toolCalls ? JSON.parse(toolCalls) : [] };
	}

	it('reads a call Pico ran without asking', async () => {
		const { content, items, toolCalls } = await parse('pico-mcp-call.sse');

		expect(items.map(({ type }) => type)).toEqual(['mcp_list_tools', 'mcp_call']);
		expect(items[1]).toMatchObject({
			arguments: '{"city":"Paris"}',
			content_offset: 0,
			name: 'weather_current',
			output: '{"city":"Paris","temp_c":21,"conditions":"sunny"}',
			status: 'completed'
		});
		expect(content).toBe("It's 21\u00b0C and sunny in Paris.");
		expect(toolCalls).toEqual([]);
	});

	it('reads a pause on an approval next to a client function call', async () => {
		const { items, toolCalls } = await parse('pico-mcp-approval.sse');

		expect(unansweredApprovalRequests(items)).toEqual([
			expect.objectContaining({ name: 'write_file', type: 'mcp_approval_request' })
		]);
		expect(toolCalls).toEqual([
			expect.objectContaining({
				function: { arguments: '{}', name: 'get_datetime' },
				id: 'call_d1'
			})
		]);
	});

	it('reads the approved call on resume', async () => {
		const { content, items } = await parse('pico-mcp-resume.sse');

		expect(items).toEqual([
			expect.objectContaining({
				approval_request_id: 'mcpr_fixture1',
				error: null,
				name: 'write_file',
				status: 'completed',
				type: 'mcp_call'
			})
		]);
		expect(content).toBe('Saved the weather to notes.txt.');
	});
});

describe('Pico mcp item helpers', () => {
	it('cuts message text where items appeared', () => {
		expect(
			mcpItemRuns('Let me check.It is cloudy.', [
				{ ...weatherCall, content_offset: 13 },
				{ ...listItem, content_offset: 0 }
			])
		).toEqual([
			{ items: [{ ...listItem, content_offset: 0 }], text: '' },
			{ items: [{ ...weatherCall, content_offset: 13 }], text: 'Let me check.' },
			{ items: [], text: 'It is cloudy.' }
		]);
		expect(mcpItemRuns('Answer.', [weatherCall])).toEqual([
			{ items: [weatherCall], text: 'Answer.' }
		]);
		expect(mcpItemRuns('Answer.', [])).toEqual([{ items: [], text: 'Answer.' }]);
	});

	it("recognizes a connection to Pico's own /mcp", () => {
		expect(isPicoMcpUrl(`${PICO_ORIGIN}mcp`)).toBe(true);
		expect(isPicoMcpUrl(`${PICO_ORIGIN}mcp/`)).toBe(true);
		expect(isPicoMcpUrl('./mcp')).toBe(true);
		expect(isPicoMcpUrl('http://other.local:8080/mcp')).toBe(false);
		expect(isPicoMcpUrl('https://mcp.example.com/mcp')).toBe(false);
	});

	it('reads OpenAI error objects and plain strings', () => {
		expect(
			mcpCallErrorText({ code: -32602, message: 'Unknown tool', type: 'mcp_protocol_error' })
		).toBe('Unknown tool');
		expect(
			mcpCallErrorText({ content: [{ text: 'disk full' }], type: 'mcp_tool_execution_error' })
		).toBe('[{"text":"disk full"}]');
		expect(mcpCallErrorText('timed out')).toBe('timed out');
		expect(mcpCallErrorText(null)).toBeNull();
	});
});
