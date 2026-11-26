import '../../src/app.css';
import completedResponse from '../unit/fixtures/open-responses/pico-completed-response.json';
import PicoChatScreenHarness from './components/PicoChatScreenHarness.svelte';
import { HEADERS, IS_PICO_BUILD } from '$lib/constants';
import {
	MessageRole,
	MessageType,
	ReasoningEffort,
	ServerModelStatus,
	ServerRole
} from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { ApiLlamaCppServerProps, ApiModelDataEntry, ModelOption } from '$lib/types';
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

const GEMMA = 'routing/Gemma-4';
const ASTREA = 'Astrea-R8-Chat-9B-OptiQ-4bit';
const INKLING = 'Inkling-2-Mini';
const OVERRIDE = 'routing/engine/Override-4bit';
const createdIds = new Set<string>();

interface RequestRecord {
	body: Record<string, unknown>;
	headers: Headers;
	method: string;
	resumeModel?: string | null;
	url: URL;
}

let requests: RequestRecord[];
let previousConfig: SettingsConfigType;
let listedModels: ModelOption[];
let modelStatuses: Map<string, ServerModelStatus>;

function props(model = GEMMA, role = ServerRole.ROUTER): ApiLlamaCppServerProps {
	return {
		bos_token: '',
		build_info: 'Pico model routing test',
		chat_template: model === INKLING ? '{% if enable_thinking %}think{% endif %}' : '',
		chat_template_caps: { reasoning_effort_levels: model === INKLING ? ['high'] : [] },
		default_generation_settings: {
			n_ctx: 4096
		} as ApiLlamaCppServerProps['default_generation_settings'],
		eos_token: '',
		modalities: { audio: false, video: false, vision: model === INKLING },
		model_alias: model,
		model_path: model === INKLING ? 'thinkingmachines/Inkling-2-Mini' : model,
		role,
		server_name: 'Pico routing test',
		total_slots: 1
	} as ApiLlamaCppServerProps;
}

function option(model: string): ModelOption {
	return {
		capabilities: [],
		id: model,
		model,
		name: model === INKLING ? 'Inkling 2 Mini' : model === ASTREA ? 'Astrea R8 Chat' : model
	};
}

function routerEntry(model: string, status = ServerModelStatus.UNLOADED): ApiModelDataEntry {
	return {
		created: 0,
		id: model,
		in_cache: true,
		object: 'model',
		owned_by: 'Pico routing test',
		path: `/models/${model}`,
		status: { value: status }
	};
}

beforeEach(async () => {
	await page.viewport(1280, 900);
	await DatabaseService.useStore(localChatStore);
	previousConfig = { ...settingsStore.config };
	settingsStore.config = {
		...settingsStore.config,
		apiEndpoint: 'responses',
		customJson: '',
		preEncodeConversation: false,
		systemMessage: '',
		titleGenerationUseLLM: false
	};
	serverStore.role = ServerRole.ROUTER;
	serverStore.props = props();
	serverStore.error = null;
	serverStore.loading = false;
	conversationsStore.clearActiveConversation();
	conversationsStore.conversations = [];
	chatStore.clearEditMode();
	chatStore.errorDialogState = null;
	modelsStore.models = [GEMMA, INKLING, OVERRIDE].map(option);
	modelsStore.routerModels = [];
	modelsStore.hiddenModelIds = new Set();
	modelsStore.favoriteModelIds = new Set();
	modelsStore.loading = false;
	modelsStore.updating = false;
	modelsStore.clearSelection();
	vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
	vi.spyOn(modelsStore.status, 'ensureLoaded').mockResolvedValue();
	vi.spyOn(modelsStore.status, 'load').mockResolvedValue();
	vi.spyOn(agenticStore, 'runAgenticFlow').mockResolvedValue({ handled: false });
	requests = [];
	listedModels = [INKLING, GEMMA, OVERRIDE].map(option);
	modelStatuses = new Map();
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		const headers = new Headers(init?.headers);
		const conversationId = headers.get(HEADERS.X_CONVERSATION_ID_HEADER);
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

		requests.push({
			body,
			headers,
			method: init?.method ?? 'GET',
			resumeModel: conversationId ? ChatService.getStreamState(conversationId)?.model : undefined,
			url
		});

		if (url.pathname === '/props')
			return Response.json(
				props(
					url.searchParams.get('model') ?? serverStore.props?.model_alias ?? GEMMA,
					serverStore.role ?? ServerRole.ROUTER
				)
			);

		if (url.pathname === '/v1/models') {
			return Response.json({
				data: listedModels.map(({ model }) => routerEntry(model, modelStatuses.get(model))),
				models: listedModels.map(({ model, name }) => ({ model, name }))
			});
		}

		if (url.pathname === '/v1/responses') {
			return new Response(
				`event: response.completed\ndata: ${JSON.stringify({ response: { ...completedResponse, model: body.model ?? GEMMA }, type: 'response.completed' })}\n\ndata: [DONE]\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } }
			);
		}

		if (url.pathname === '/v1/chat/completions') {
			const chunk = {
				choices: [
					{ delta: { content: 'Reply from the selected model' }, finish_reason: null, index: 0 }
				],
				id: 'completion-routing',
				model: body.model ?? GEMMA
			};

			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { 'Content-Type': 'text/event-stream' }
			});
		}

		if (init?.method === 'DELETE') return new Response(null, { status: 204 });

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
	modelsStore.routerModels = [];
	modelsStore.clearSelection();
	serverStore.clear();
	settingsStore.config = previousConfig;
	vi.restoreAllMocks();
});

async function prepareResponse() {
	const conversation = await DatabaseService.createConversation('Routing test');

	createdIds.add(conversation.id);
	const root = await DatabaseService.createRootMessage(conversation.id);
	const user = await DatabaseService.createMessageBranch(
		{
			children: [],
			content: 'Question',
			convId: conversation.id,
			parent: root,
			role: MessageRole.USER,
			timestamp: Date.now(),
			type: MessageType.TEXT
		},
		root
	);

	expect(await conversationsStore.loadConversation(conversation.id)).toBe(true);
	const assistant = await chatStore.createAssistantMessage(user.id);

	conversationsStore.addMessageToActive(assistant);

	return { assistant, conversation, user };
}

const generationRequests = () =>
	requests.filter(
		({ method, url }) =>
			method === 'POST' && ['/v1/responses', '/v1/chat/completions'].includes(url.pathname)
	);

async function fetchCatalog(role: ServerRole, defaultModel = INKLING) {
	serverStore.role = role;
	serverStore.props = props(defaultModel, role);
	listedModels = [ASTREA, INKLING].map(option);
	modelsStore.models = [];
	modelsStore.routerModels = [];
	modelsStore.clearSelection();
	vi.mocked(modelsStore.fetch).mockRestore();
	await modelsStore.fetch();
}

describe.runIf(IS_PICO_BUILD)('Pico configured default and presentation policy', () => {
	it.each([ServerRole.MODEL, ServerRole.ROUTER])(
		'resolves the configured identifier instead of the alphabetical first model in %s mode',
		async (role) => {
			await fetchCatalog(role);
			await modelsStore.ensureFirstModelSelected();

			expect(serverStore.props?.model_path).toBe('thinkingmachines/Inkling-2-Mini');
			expect(modelsStore.models.map(({ name }) => name)).toEqual([
				'Astrea R8 Chat',
				'Inkling 2 Mini'
			]);
			expect(modelsStore.models.map(({ id }) => id)).toEqual([ASTREA, INKLING]);
			expect(modelsStore.activeModelId).toBe(INKLING);
			expect(serverStore.supportsModelSelection).toBe(role === ServerRole.ROUTER);
		}
	);

	it.each([ServerModelStatus.LOADING, ServerModelStatus.LOADED])(
		'keeps the configured default while another model is %s',
		async (status) => {
			modelStatuses.set(ASTREA, status);
			await fetchCatalog(ServerRole.ROUTER);
			await modelsStore.ensureFirstModelSelected();
			await modelsStore.ensureFirstModelSelected();

			expect(modelsStore.activeModelId).toBe(INKLING);
		}
	);

	it.each([ServerRole.MODEL, ServerRole.ROUTER])(
		'uses an exact identifier when models have the same friendly name in %s mode',
		async (role) => {
			const first = 'publisher-a/Inkling-2-Mini';
			const configured = 'publisher-b/Inkling-2-Mini';

			serverStore.role = role;
			serverStore.props = props(configured, role);
			listedModels = [first, configured].map((model) => ({
				...option(model),
				name: 'Inkling 2 Mini'
			}));
			modelsStore.models = [];
			vi.mocked(modelsStore.fetch).mockRestore();
			await modelsStore.fetch();
			await modelsStore.ensureFirstModelSelected();

			expect(modelsStore.activeModelId).toBe(configured);
		}
	);

	it.each([1280, 390])('shows a noninteractive default-model label at width %s', async (width) => {
		await page.viewport(width, 900);
		await fetchCatalog(ServerRole.MODEL);
		const screen = render(PicoChatScreenHarness);

		await expect
			.element(screen.getByLabelText('Response model'))
			.toHaveTextContent('Inkling 2 Mini');
		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Model for the next response' }))
			.not.toBeInTheDocument();
		expect(modelsStore.models).toHaveLength(2);
	});

	it.each(['responses', 'chat_completions'] as const)(
		'sends the configured default to %s despite another selected model in default-only mode',
		async (endpoint) => {
			settingsStore.config.apiEndpoint = endpoint;
			await fetchCatalog(ServerRole.MODEL);
			await modelsStore.selectModelById(ASTREA);
			const screen = render(PicoChatScreenHarness);

			await screen.getByRole('textbox').fill('Use the configured default');
			await screen.getByRole('button', { exact: true, name: 'Send' }).click();
			await vi.waitFor(() => expect(generationRequests()).toHaveLength(1));

			expect(modelsStore.activeModelId).toBe(INKLING);
			expect(generationRequests()[0].body.model).toBe(INKLING);
			expect(modelsStore.status.ensureLoaded).not.toHaveBeenCalled();
			expect(modelsStore.status.load).not.toHaveBeenCalled();
			expect(requests.some(({ url }) => url.pathname === '/models/load')).toBe(false);
			await vi.waitFor(() =>
				expect(chatStore.isChatLoadingInternal(conversationsStore.activeConversation!.id)).toBe(
					false
				)
			);
		}
	);

	it.each(['responses', 'chat_completions'] as const)(
		'keeps the default model while applying custom JSON parameters to %s',
		async (endpoint) => {
			settingsStore.config.apiEndpoint = endpoint;
			settingsStore.config.customJson = JSON.stringify({ model: ASTREA, temperature: 0.2 });
			await fetchCatalog(ServerRole.MODEL);
			const screen = render(PicoChatScreenHarness);

			await screen.getByRole('textbox').fill('Keep the configured model');
			await screen.getByRole('button', { exact: true, name: 'Send' }).click();
			await vi.waitFor(() => expect(generationRequests()).toHaveLength(1));

			expect(generationRequests()[0].body.model).toBe(INKLING);
			expect(generationRequests()[0].body.temperature).toBe(0.2);
			await vi.waitFor(() =>
				expect(chatStore.isChatLoadingInternal(conversationsStore.activeConversation!.id)).toBe(
					false
				)
			);
		}
	);

	it('ignores an earlier request selection, override and history after default-only is enabled', async () => {
		await fetchCatalog(ServerRole.ROUTER);
		const { assistant, user } = await prepareResponse();
		const history = {
			...assistant,
			content: 'Earlier reply',
			id: 'prior-assistant',
			model: ASTREA
		};

		await modelsStore.selectModelById(ASTREA);
		const snapshot = chatStore.getRequestSnapshot();

		serverStore.role = ServerRole.MODEL;
		serverStore.props = props(INKLING, ServerRole.MODEL);
		await chatStore.streamChatCompletion(
			[history, user],
			assistant,
			undefined,
			undefined,
			ASTREA,
			undefined,
			snapshot
		);

		expect(generationRequests()[0].body.model).toBe(INKLING);
		await vi.waitFor(() => expect(chatStore.isChatLoadingInternal(assistant.convId)).toBe(false));
	});

	it.each([ServerRole.MODEL, ServerRole.ROUTER])(
		'does not substitute another model when the configured default is unavailable in %s mode',
		async (role) => {
			await fetchCatalog(role, 'missing/Inkling-2-Mini');
			await modelsStore.ensureFirstModelSelected();
			const screen = render(PicoChatScreenHarness);

			await screen.getByRole('textbox').fill('Wait for the default model');
			expect(modelsStore.activeModelId).toBeNull();
			await expect
				.element(screen.getByRole('button', { exact: true, name: 'Send' }))
				.toBeDisabled();
		}
	);

	it.each([false, true])(
		'preserves an explicit router selection with fromLink=%s',
		async (fromLink) => {
			await fetchCatalog(ServerRole.ROUTER);
			await modelsStore.selectModelById(ASTREA, { fromLink });
			modelsStore.routerModels = [
				routerEntry(ASTREA),
				routerEntry(INKLING, ServerModelStatus.LOADING)
			];
			await modelsStore.ensureFirstModelSelected();
			await modelsStore.fetch(true);
			await modelsStore.ensureFirstModelSelected();

			expect(modelsStore.activeModelId).toBe(ASTREA);
			expect(serverStore.props?.model_alias).toBe(INKLING);
		}
	);

	it('keeps the existing conversation model ahead of the router default', async () => {
		await fetchCatalog(ServerRole.ROUTER);
		const { assistant } = await prepareResponse();

		conversationsStore.activeMessages = [{ ...assistant, content: 'Earlier reply', model: ASTREA }];
		modelsStore.clearSelection();
		await modelsStore.ensureFirstModelSelected();

		expect(modelsStore.activeModelId).toBe(ASTREA);
		expect(conversationsStore.activeMessages[0].model).toBe(ASTREA);
	});
});

describe.runIf(IS_PICO_BUILD)('Pico model selection in ROUTER mode', () => {
	it('starts with the configured server model and preserves an explicit pick on refresh', async () => {
		modelsStore.models = [];
		vi.mocked(modelsStore.fetch).mockRestore();
		const screen = render(PicoChatScreenHarness);
		const picker = screen.getByRole('button', { exact: true, name: 'Model for the next response' });

		await expect.element(picker).toHaveTextContent('Gemma');
		expect(modelsStore.selectedModelName).toBe(GEMMA);
		expect(modelsStore.activeModelId).toBe(GEMMA);
		modelsStore.clearSelection();
		await modelsStore.ensureFirstModelSelected();
		expect(modelsStore.activeModelId).toBe(GEMMA);
		await picker.click();
		await page.getByRole('option', { name: /Inkling/ }).click();
		await modelsStore.fetch(true);
		await expect.element(picker).toHaveTextContent('Inkling');
		expect(modelsStore.selectedModelName).toBe(INKLING);
		expect(modelsStore.activeModelId).toBe(INKLING);
	});

	it.each(['responses', 'chat_completions'] as const)(
		'sends the real composer choice to %s and records its raw response model',
		async (endpoint) => {
			settingsStore.config.apiEndpoint = endpoint;
			const screen = render(PicoChatScreenHarness);
			const picker = screen.getByRole('button', {
				exact: true,
				name: 'Model for the next response'
			});

			await picker.click();
			await page.getByRole('option', { name: /Inkling/ }).click();
			await expect.element(picker).toHaveTextContent('Inkling');
			expect(modelsStore.activeModelId).toBe(INKLING);
			await expect.poll(() => modelsStore.props.modelSupportsVision(INKLING)).toBe(true);
			expect(modelsStore.props.modelSupportsVision(GEMMA)).toBe(false);
			expect(modelsStore.props.checkModelSupportsThinking(INKLING)).toBe(true);
			expect(modelsStore.props.getReasoningEfforts(INKLING)).toEqual([ReasoningEffort.HIGH]);
			await screen.getByRole('textbox').fill('Write with Inkling');
			await screen.getByRole('button', { exact: true, name: 'Send' }).click();
			await vi.waitFor(() => expect(generationRequests()).toHaveLength(1));
			const conversationId = conversationsStore.activeConversation!.id;
			const request = generationRequests()[0];

			expect(request.body.model).toBe(INKLING);
			expect(request.url.pathname).toBe(
				endpoint === 'responses' ? '/v1/responses' : '/v1/chat/completions'
			);

			if (endpoint === 'chat_completions') {
				expect(request.headers.get(HEADERS.X_CONVERSATION_ID_HEADER)).toBe(conversationId);
				expect(request.resumeModel).toBeNull();
			}

			await expect
				.poll(
					async () =>
						(await DatabaseService.getConversationMessages(conversationId)).find(
							(message) => message.role === MessageRole.ASSISTANT
						)?.model
				)
				.toBe(INKLING);
			await vi.waitFor(() => expect(chatStore.isChatLoadingInternal(conversationId)).toBe(false));
			expect(modelsStore.status.ensureLoaded).not.toHaveBeenCalled();
			expect(modelsStore.status.load).not.toHaveBeenCalled();
			expect(requests.some(({ url }) => url.pathname === '/models/sse')).toBe(false);
			expect(serverStore.props?.model_alias).toBe(GEMMA);
		}
	);

	it.each([undefined, OVERRIDE])(
		'keeps a captured request model with override %s after another selection',
		async (override) => {
			const { assistant, user } = await prepareResponse();

			await modelsStore.selectModelById(option(INKLING).id);
			const snapshot = chatStore.getRequestSnapshot();

			await modelsStore.selectModelById(option(GEMMA).id);
			await chatStore.streamChatCompletion(
				[user],
				assistant,
				undefined,
				undefined,
				override,
				undefined,
				snapshot
			);
			expect(generationRequests()[0].body.model).toBe(override ?? INKLING);
			await vi.waitFor(() => expect(chatStore.isChatLoadingInternal(assistant.convId)).toBe(false));
		}
	);

	it('stops a selected Pico model with the bare conversation identity', async () => {
		const { assistant, conversation, user } = await prepareResponse();

		await modelsStore.selectModelById(option(INKLING).id);
		let entered!: () => void;
		let release!: () => void;
		let requestedModel: string | null | undefined;

		const started = new Promise<void>((resolve) => (entered = resolve));
		const finish = new Promise<void>((resolve) => (release = resolve));

		vi.spyOn(ChatService, 'sendMessage').mockImplementation(async (_messages, options) => {
			requestedModel = options?.model;
			entered();
			await finish;
		});
		const completion = chatStore.streamChatCompletion([user], assistant);

		try {
			await started;
			expect(requestedModel).toBe(INKLING);
			await chatStore.stopGenerationForChat(conversation.id);
			expect(
				requests.find(({ method }) => method === 'DELETE')?.url.searchParams.get('conv_id')
			).toBe(conversation.id);
		} finally {
			release();
			await completion;
		}
	});

	it('keeps a non-Pico single-model request on the server model', async () => {
		serverStore.role = ServerRole.MODEL;
		serverStore.props = { ...props(GEMMA, ServerRole.MODEL), server_name: undefined };
		const { assistant, user } = await prepareResponse();

		await modelsStore.selectModelById(option(INKLING).id);
		await chatStore.streamChatCompletion([user], assistant);
		expect(modelsStore.activeModelId).toBe(GEMMA);
		expect(generationRequests()[0].body).not.toHaveProperty('model');
		await vi.waitFor(() => expect(chatStore.isChatLoadingInternal(assistant.convId)).toBe(false));
	});
});
