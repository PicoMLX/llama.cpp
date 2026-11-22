import PicoComposerHarness from './components/PicoComposerHarness.svelte';
import { IS_PICO_BUILD } from '$lib/constants';
import { MessageRole, MessageType, ServerModelStatus, ServerRole } from '$lib/enums';
import { PropsService } from '$lib/services/props.service';
import { chatStore, conversationsStore, modelsStore, serverStore } from '$lib/stores';
import type {
	ApiLlamaCppServerProps,
	ApiModelDataEntry,
	DatabaseMessage,
	ModelOption
} from '$lib/types';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const MODEL = 'example/alpha-8b:Q4_K_M';
const OTHER_MODEL = 'example/beta-8b:Q4_K_M';
const CONVERSATION = 'pico-composer-conversation';

function option(model: string): ModelOption {
	return { capabilities: [], id: model, model, name: model };
}

function listing(id: string, status = ServerModelStatus.LOADED): ApiModelDataEntry {
	return {
		created: 0,
		id,
		in_cache: true,
		object: 'model',
		owned_by: 'llamacpp',
		path: `/models/${id}`,
		status: { value: status }
	};
}

function assistant(promptTokens: number): DatabaseMessage {
	return {
		children: [],
		content: 'A response',
		convId: CONVERSATION,
		id: 'composer-assistant',
		model: MODEL,
		parent: null,
		role: MessageRole.ASSISTANT,
		timestamp: 1,
		timings: { predicted_ms: 200, predicted_n: 20, prompt_ms: 200, prompt_n: promptTokens },
		type: MessageType.TEXT
	};
}

beforeEach(async () => {
	await page.viewport(1280, 900);
	serverStore.role = ServerRole.ROUTER;
	serverStore.error = null;
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	modelsStore.models = [option(MODEL), option(OTHER_MODEL)];
	modelsStore.hiddenModelIds = new Set();
	modelsStore.routerModels = [listing(MODEL), listing(OTHER_MODEL)];
	modelsStore.selectedModelId = MODEL;
	modelsStore.selectedModelName = MODEL;
	modelsStore.loading = false;
	modelsStore.updating = false;
	vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
	vi.spyOn(modelsStore.props, 'fetchModalitiesForLoadedModels').mockResolvedValue();
	vi.spyOn(modelsStore.props, 'getModelProps').mockReturnValue({
		default_generation_settings: { n_ctx: 1000 }
	} as ApiLlamaCppServerProps);
	vi.spyOn(modelsStore.props, 'getModelContextSize').mockReturnValue(1000);
	vi.spyOn(modelsStore.props, 'checkModelSupportsThinking').mockReturnValue(false);
});

afterEach(() => {
	chatStore.clearPendingEditMessageId();
	chatStore.processing.setState(CONVERSATION, null);
	chatStore.processing.setActiveConversation(null);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	modelsStore.models = [];
	modelsStore.routerModels = [];
	modelsStore.clearSelection();
	serverStore.role = null;
	vi.restoreAllMocks();
});

describe.runIf(IS_PICO_BUILD)('Pico composing controls', () => {
	it('keeps one model picker in the header and hides unsupported Thinking', async () => {
		const screen = render(PicoComposerHarness);

		await expect
			.element(screen.getByRole('button', { name: 'Model for the next response' }))
			.toBeVisible();
		expect(
			screen.container.querySelector('form [aria-label="Model for the next response"]')
		).toBeNull();
		expect(screen.container.querySelector('[aria-label="Thinking"]')).toBeNull();
		expect(screen.container.querySelector('[data-context-gauge-trigger]')).toBeNull();
	});

	it('shows Thinking only when the selected model supports it', async () => {
		vi.mocked(modelsStore.props.checkModelSupportsThinking).mockReturnValue(true);
		const screen = render(PicoComposerHarness);

		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Thinking' }))
			.toBeVisible();
	});

	it('fetches reasoning metadata in effects and refreshes it when the selected model changes', async () => {
		vi.mocked(modelsStore.props.checkModelSupportsThinking).mockRestore();
		vi.mocked(modelsStore.props.getModelProps).mockRestore();
		const first = 'effect/first:Q4_K_M';
		const second = 'effect/second:Q4_K_M';

		modelsStore.models = [option(first), option(second)];
		modelsStore.routerModels = [listing(first), listing(second)];
		modelsStore.selectedModelId = first;
		modelsStore.selectedModelName = first;
		const fetchProps = vi.spyOn(PropsService, 'fetchForModel').mockImplementation(
			async (id) =>
				({
					chat_template: id === first ? '{% if enable_thinking %}Think{% endif %}' : '',
					chat_template_caps: { reasoning_effort_levels: id === first ? ['low', 'high'] : [] },
					default_generation_settings: { n_ctx: 1000 }
				}) as ApiLlamaCppServerProps
		);
		const screen = render(PicoComposerHarness);

		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Thinking' }))
			.toBeVisible();
		expect(fetchProps.mock.calls.filter(([id]) => id === first)).toHaveLength(1);

		modelsStore.selectedModelId = second;
		modelsStore.selectedModelName = second;
		await expect.poll(() => fetchProps.mock.calls.filter(([id]) => id === second).length).toBe(1);
		await expect.poll(() => screen.container.querySelector('[aria-label="Thinking"]')).toBeNull();
	});

	it('shows a variant discriminator when friendly model names collide', async () => {
		const otherQuant = 'example/alpha-8b:Q8_0';

		modelsStore.models = [option(MODEL), option(otherQuant)];
		modelsStore.routerModels = [listing(MODEL), listing(otherQuant)];
		const screen = render(PicoComposerHarness);

		await screen.getByRole('button', { name: 'Model for the next response' }).click();
		await expect.element(page.getByText('Q4_K_M', { exact: true })).toBeVisible();
		await expect.element(page.getByText('Q8_0', { exact: true })).toBeVisible();
	});

	it('opens the header picker when validation finds no selected model', async () => {
		modelsStore.clearSelection();
		const screen = render(PicoComposerHarness);

		await tick();

		expect(screen.component.validateModel()).toBe(false);
		await expect.element(page.getByPlaceholder('Search models...')).toBeVisible();
		expect(
			screen.container.querySelectorAll('[aria-label="Model for the next response"]')
		).toHaveLength(1);
	});

	it('preserves /model dispatch through the sole header picker', async () => {
		const screen = render(PicoComposerHarness);
		const textarea = screen.container.querySelector('textarea');

		if (!textarea) throw new Error('Composer textarea is missing');

		await userEvent.click(textarea);
		await userEvent.keyboard('/model');
		await userEvent.keyboard('{Enter}');

		await expect.element(page.getByPlaceholder('Search models...')).toBeVisible();
	});

	it('selects an already loading model without starting a second load or exposing admin row controls', async () => {
		modelsStore.routerModels = [listing(MODEL), listing(OTHER_MODEL, ServerModelStatus.LOADING)];
		const load = vi.spyOn(modelsStore.status, 'load').mockResolvedValue();
		const screen = render(PicoComposerHarness);

		await screen.getByRole('button', { name: 'Model for the next response' }).click();
		await expect.element(page.getByRole('menuitem', { name: 'Manage models' })).toBeVisible();
		const optionRows = [...document.querySelectorAll('[role="option"]')];

		expect(optionRows).toHaveLength(2);
		expect(optionRows.every((optionRow) => !optionRow.querySelector('button'))).toBe(true);
		const row = page.getByRole('option', { name: /beta/i });

		await row.click();

		expect(modelsStore.selectedModelName).toBe(OTHER_MODEL);
		expect(load).not.toHaveBeenCalled();
	});

	it('can continue an old chat with a replacement model while preserving previous response provenance', async () => {
		const oldModel = 'removed/old-model';

		conversationsStore.activeConversation = {
			currNode: 'composer-assistant',
			id: CONVERSATION,
			lastModified: 1,
			name: 'Old conversation'
		};
		conversationsStore.activeMessages = [{ ...assistant(200), model: oldModel }];
		const screen = render(PicoComposerHarness);

		await tick();
		screen.component.setValue('Continue');
		await tick();

		await expect.element(screen.getByRole('button', { exact: true, name: 'Send' })).toBeDisabled();
		await screen.getByRole('button', { name: 'Model for the next response' }).click();
		await page.getByRole('option', { name: /beta/i }).click();

		await expect.poll(() => modelsStore.selectedModelName).toBe(OTHER_MODEL);
		expect(modelsStore.activeModelId).toBe(OTHER_MODEL);
		await expect.element(screen.getByRole('button', { exact: true, name: 'Send' })).toBeEnabled();
		expect(screen.component.validateModel()).toBe(true);
		expect(conversationsStore.activeMessages[0].model).toBe(oldModel);
	});

	it('retains the future model when an edited branch exposes an older response model', async () => {
		const futureModel = 'example/gamma-8b:Q4_K_M';
		const first = assistant(100);
		const second = { ...assistant(200), id: 'second-assistant', model: OTHER_MODEL };

		modelsStore.models = [option(MODEL), option(OTHER_MODEL), option(futureModel)];
		modelsStore.routerModels = [listing(MODEL), listing(OTHER_MODEL), listing(futureModel)];
		conversationsStore.activeConversation = {
			currNode: second.id,
			id: CONVERSATION,
			lastModified: 1,
			name: 'Mixed models'
		};
		conversationsStore.activeMessages = [first, second];
		const screen = render(PicoComposerHarness);

		await expect.poll(() => modelsStore.selectedModelName).toBe(OTHER_MODEL);
		await screen.getByRole('button', { name: 'Model for the next response' }).click();
		await page.getByRole('option', { name: /gamma/i }).click();
		await expect.poll(() => modelsStore.selectedModelName).toBe(futureModel);

		conversationsStore.activeMessages = [
			first,
			{
				...first,
				content: 'Edited prompt',
				id: 'edited-user',
				model: undefined,
				role: MessageRole.USER,
				timings: undefined
			}
		];
		await tick();

		expect(modelsStore.activeModelId).toBe(futureModel);
		expect(modelsStore.selectedModelName).toBe(futureModel);
		expect(first.model).toBe(MODEL);
		expect(second.model).toBe(OTHER_MODEL);

		conversationsStore.activeConversation = {
			currNode: first.id,
			id: 'another-conversation',
			lastModified: 2,
			name: 'Another chat'
		};
		conversationsStore.activeMessages = [first];
		await expect.poll(() => modelsStore.selectedModelName).toBe(MODEL);
	});

	it('exposes every saved instruction in Advanced and edits the chosen existing node', async () => {
		const first = {
			...assistant(0),
			content: 'First saved instruction',
			id: 'instruction-first',
			model: undefined,
			role: MessageRole.SYSTEM
		};
		const later = { ...first, content: 'Later imported instruction', id: 'instruction-later' };
		const response = assistant(100);
		const original = [first, response, later];

		conversationsStore.activeConversation = {
			currNode: later.id,
			id: CONVERSATION,
			lastModified: 1,
			name: 'Imported chat'
		};
		conversationsStore.activeMessages = original;
		const screen = render(PicoComposerHarness);

		await screen.getByRole('button', { name: 'Chat options' }).click();
		await page.getByRole('menuitem', { name: 'Conversation details' }).click();
		await page.getByText('Advanced', { exact: true }).click();
		await expect.element(page.getByText(first.content, { exact: true })).toBeVisible();
		await expect.element(page.getByText(later.content, { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Edit instruction 2' }).click();

		await expect.poll(() => chatStore.pendingEditMessageId).toBe(later.id);
		expect(conversationsStore.activeMessages.map(({ id }) => id)).toEqual(
			original.map(({ id }) => id)
		);
		expect(conversationsStore.activeMessages.map(({ content }) => content)).toEqual(
			original.map(({ content }) => content)
		);
	});

	it('keeps context details on demand and reveals a warning near the context limit', async () => {
		conversationsStore.activeConversation = {
			currNode: 'composer-assistant',
			id: CONVERSATION,
			lastModified: 1,
			name: 'Context test'
		};
		conversationsStore.activeMessages = [assistant(200)];
		const screen = render(PicoComposerHarness);

		expect(screen.container.textContent).not.toContain('This chat is getting long.');
		expect(screen.container.textContent).not.toContain('Context usage');

		conversationsStore.activeMessages = [assistant(800)];
		await expect.element(screen.getByText('This chat is getting long.')).toBeVisible();
		await screen.getByRole('button', { name: 'View details' }).click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect.element(page.getByText('820 of 1,000 tokens (82%)')).toBeVisible();
	});

	it('opens the existing Instructions flow from chat options', async () => {
		const onInstructions = vi.fn();
		const screen = render(PicoComposerHarness, { onInstructions });

		await screen.getByRole('button', { name: 'Chat options' }).click();
		await page.getByRole('menuitem', { name: 'Instructions' }).click();

		expect(onInstructions).toHaveBeenCalledOnce();
	});
});
