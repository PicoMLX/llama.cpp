import '../../src/app.css';
import approvalStream from '../unit/fixtures/open-responses/openai-mcp-approval.sse?raw';
import approvedCallStream from '../unit/fixtures/open-responses/openai-mcp-approved-call.sse?raw';
import callStream from '../unit/fixtures/open-responses/openai-mcp-call.sse?raw';
import PicoChatScreenHarness from './components/PicoChatScreenHarness.svelte';
import { ServerRole } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ToolsService } from '$lib/services/tools.service';
import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { ApiLlamaCppServerProps, PicoToolInfo } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	afterNavigate: () => {},
	beforeNavigate: () => {},
	disableScrollHandling: () => {},
	goto: vi.fn(async () => {}),
	onNavigate: () => {}
}));

// Streams are OpenAI's documented Responses MCP items and events, as Pico sends them
const MODEL = 'Qwen3-8B';
const PICO_TOOLS: PicoToolInfo[] = [
	{ approvalRequired: false, name: 'weather_current', readOnly: true, title: 'Current Weather' },
	{ approvalRequired: true, name: 'reminders_create', title: 'Create Reminder' }
];
const TEXT_STREAM = `event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":0,"output_index":0,"item_id":"msg_9","content_index":0,"delta":"OK, I will not add it."}

event: response.completed
data: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_9","object":"response","status":"completed","model":"${MODEL}","output":[]}}

`;
const createdIds = new Set<string>();

let previousConfig: SettingsConfigType;
let responseBodies: Array<Record<string, unknown>>;
let streams: Array<string | ReadableStream<Uint8Array>>;

function sse(body: string | ReadableStream<Uint8Array>): Response {
	return new Response(typeof body === 'string' ? new Blob([body]).stream() : body, {
		headers: { 'Content-Type': 'text/event-stream' }
	});
}

/** A stream that sends `first`, then the rest once the test calls `release`. */
function heldStream(body: string, splitBefore: string) {
	const at = body.indexOf(splitBefore);
	const encoder = new TextEncoder();

	let release = () => {};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body.slice(0, at)));
			release = () => {
				controller.enqueue(encoder.encode(body.slice(at)));
				controller.close();
			};
		}
	});

	return { release: () => release(), stream };
}

async function send(screen: ReturnType<typeof render>, text: string) {
	await screen.getByRole('textbox').fill(text);
	await screen.getByRole('button', { exact: true, name: 'Send' }).click();
}

beforeEach(async () => {
	await page.viewport(1280, 900);
	await DatabaseService.useStore(localChatStore);
	previousConfig = { ...settingsStore.config };
	settingsStore.config = {
		...settingsStore.config,
		apiEndpoint: 'responses',
		customJson: '',
		jsSandboxEnabled: false,
		preEncodeConversation: false,
		systemMessage: '',
		titleGenerationUseLLM: false
	};
	serverStore.role = ServerRole.MODEL;
	serverStore.props = {
		bos_token: '',
		build_info: 'Pico tools test',
		chat_template: '',
		default_generation_settings: { n_ctx: 8192 },
		eos_token: '',
		modalities: { audio: false, vision: false },
		model_alias: MODEL,
		model_path: MODEL,
		role: ServerRole.MODEL,
		server_name: 'Pico AI Server',
		total_slots: 1
	} as unknown as ApiLlamaCppServerProps;
	serverStore.error = null;
	serverStore.loading = false;
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	modelsStore.models = [{ capabilities: [], id: MODEL, model: MODEL, name: MODEL }];
	modelsStore.routerModels = [];
	modelsStore.clearSelection();
	modelsStore.loading = false;
	modelsStore.updating = false;
	vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
	vi.spyOn(modelsStore.status, 'ensureLoaded').mockResolvedValue();
	vi.spyOn(modelsStore.status, 'load').mockResolvedValue();
	vi.spyOn(ToolsService, 'listPicoTools').mockResolvedValue(PICO_TOOLS);
	responseBodies = [];
	streams = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);

		if (url.pathname.endsWith('/v1/responses')) {
			responseBodies.push(JSON.parse(init?.body as string));

			return sse(streams.shift() ?? TEXT_STREAM);
		}

		if (url.pathname.endsWith('/props')) return Response.json(serverStore.props);

		if (url.pathname.endsWith('/tools')) return new Response('Not found', { status: 404 });

		return Response.json([]);
	});
});

afterEach(async () => {
	const activeId = conversationsStore.activeConversation?.id;

	if (activeId) createdIds.add(activeId);

	for (const id of createdIds) {
		chatStore.cleanupStreaming(id);
		chatStore.dismissResponseError(id);
		ChatService.clearStreamState(id);
		draftMessagesStore.clearDraftMessage(id);
	}
	await DatabaseService.bulkDeleteConversations([...createdIds]);
	createdIds.clear();
	draftMessagesStore.clearDraftMessage(undefined);
	chatStore.errorDialogState = null;
	chatStore.processing.setActiveConversation(null);
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	modelsStore.models = [];
	modelsStore.clearSelection();
	serverStore.clear();
	settingsStore.config = previousConfig;
	vi.restoreAllMocks();
});

const isIdle = () =>
	expect(chatStore.isChatLoadingInternal(conversationsStore.activeConversation!.id)).toBe(false);

describe('Pico tools in the chat', () => {
	it('sends one pico mcp entry, shows the call live, then a collapsed summary', async () => {
		const held = heldStream(callStream, 'event: response.mcp_call.completed');

		streams.push(held.stream);
		const screen = render(PicoChatScreenHarness);

		await send(screen, 'Weather in Amsterdam?');

		await expect.element(screen.getByText('Using Current Weather...')).toBeVisible();
		expect(responseBodies[0].tools).toContainEqual({
			allowed_tools: ['weather_current', 'reminders_create'],
			require_approval: { never: { tool_names: ['weather_current'] } },
			server_label: 'pico',
			server_url: new URL('./mcp', window.location.href).href,
			type: 'mcp'
		});
		expect(
			(responseBodies[0].tools as Array<{ name?: string }>).map((tool) => tool.name)
		).not.toContain('weather_current');

		held.release();

		const summary = screen.getByText('Used Current Weather');

		await expect.element(summary).toBeVisible();
		await expect.element(screen.getByText('It is 12 C and cloudy.')).toBeVisible();
		await expect.element(screen.getByText(/"temperature_c":12/)).not.toBeInTheDocument();

		await summary.click();
		await expect.element(screen.getByText(/"temperature_c":12/)).toBeVisible();
		await vi.waitFor(isIdle);
	});

	it('asks before a call that needs approval, then sends the approval with the next request', async () => {
		streams.push(approvalStream, approvedCallStream);
		const screen = render(PicoChatScreenHarness);

		await send(screen, 'Remind me to buy milk');

		await expect.element(screen.getByText(/Allow use of/)).toHaveTextContent('Create Reminder');
		await expect.element(screen.getByText(/"title": "Buy milk"/)).toBeVisible();
		expect(responseBodies).toHaveLength(1);

		await screen.getByRole('button', { exact: true, name: 'Allow once' }).click();

		await vi.waitFor(() => expect(responseBodies).toHaveLength(2));
		expect((responseBodies[1].input as unknown[]).slice(-3)).toEqual([
			{
				content: 'I will add that reminder.',
				role: 'assistant',
				status: 'completed',
				type: 'message'
			},
			{
				arguments: '{"title":"Buy milk"}',
				id: 'mcpr_1',
				name: 'reminders_create',
				server_label: 'pico',
				type: 'mcp_approval_request'
			},
			{ approval_request_id: 'mcpr_1', approve: true, type: 'mcp_approval_response' }
		]);

		await expect.element(screen.getByText('Used Create Reminder')).toBeVisible();
		await expect.element(screen.getByText('Added: Buy milk.')).toBeVisible();
		await vi.waitFor(isIdle);
	});

	it('keeps the paused call after a stop and denies it with the next request', async () => {
		streams.push(approvalStream, TEXT_STREAM);
		const screen = render(PicoChatScreenHarness);

		await send(screen, 'Remind me to buy milk');
		await expect.element(screen.getByText(/Allow use of/)).toBeVisible();

		await screen.getByRole('button', { name: /^Stop/ }).click();
		await vi.waitFor(isIdle);
		await expect.element(screen.getByText(/Allow use of/)).not.toBeInTheDocument();
		await expect.element(screen.getByText('Declined Create Reminder')).toBeVisible();

		await send(screen, 'Never mind');
		await vi.waitFor(() => expect(responseBodies).toHaveLength(2));
		expect((responseBodies[1].input as unknown[]).slice(-3)).toEqual([
			{
				arguments: '{"title":"Buy milk"}',
				id: 'mcpr_1',
				name: 'reminders_create',
				server_label: 'pico',
				type: 'mcp_approval_request'
			},
			{ approval_request_id: 'mcpr_1', approve: false, type: 'mcp_approval_response' },
			{ content: 'Never mind', role: 'user' }
		]);
		await vi.waitFor(isIdle);
	});

	it('denies the pending call explicitly when the user sends a new message instead', async () => {
		streams.push(approvalStream, TEXT_STREAM);
		const screen = render(PicoChatScreenHarness);

		await send(screen, 'Remind me to buy milk');
		await expect.element(screen.getByText(/Allow use of/)).toBeVisible();

		await chatStore.sendMessage('Never mind');

		await vi.waitFor(() => expect(responseBodies).toHaveLength(2));
		expect((responseBodies[1].input as unknown[]).slice(-3)).toEqual([
			{
				arguments: '{"title":"Buy milk"}',
				id: 'mcpr_1',
				name: 'reminders_create',
				server_label: 'pico',
				type: 'mcp_approval_request'
			},
			{ approval_request_id: 'mcpr_1', approve: false, type: 'mcp_approval_response' },
			{ content: 'Never mind', role: 'user' }
		]);
		await expect.element(screen.getByText(/Allow use of/)).not.toBeInTheDocument();
		await expect.element(screen.getByText('Declined Create Reminder')).toBeVisible();
		await vi.waitFor(isIdle);
	});
});
