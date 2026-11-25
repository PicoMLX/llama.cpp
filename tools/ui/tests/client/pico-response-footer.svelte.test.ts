import PicoMessageFooterHarness from './components/PicoMessageFooterHarness.svelte';
import PicoResponseDetails from '$lib/components/app/chat/ChatMessages/PicoResponseDetails.svelte';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { MessageRole, MessageType, ServerRole } from '$lib/enums';
import type { UseProcessingStateReturn } from '$lib/hooks/use-processing-state.svelte';
import { ModelsService } from '$lib/services/models.service';
import {
	agenticStore,
	chatStore,
	conversationsStore,
	modelsStore,
	serverStore,
	settingsStore
} from '$lib/stores';
import type { ChatMessageActions, DatabaseMessage } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const timings = { predicted_ms: 2000, predicted_n: 80, prompt_ms: 500, prompt_n: 600 };
const processingState: UseProcessingStateReturn = {
	getLiveGenerationStats: () => null,
	getLiveProcessingStats: () => null,
	getProcessingDetails: () => [],
	getProcessingMessage: () => '',
	getPromptProgressText: () => null,
	getTechnicalDetails: () => [],
	processingState: null,
	shouldShowDetails: () => false,
	startMonitoring: () => {},
	stopMonitoring: () => {}
};

function message(role = MessageRole.ASSISTANT): DatabaseMessage {
	return {
		children: [],
		content: 'A short message.',
		convId: 'footer-conversation',
		id: role,
		model: role === MessageRole.ASSISTANT ? 'example/model-q4' : undefined,
		parent: null,
		role,
		timestamp: 123,
		timings: role === MessageRole.ASSISTANT ? timings : undefined,
		type: MessageType.TEXT
	};
}

function actions(): ChatMessageActions {
	return {
		continueAssistantMessage: vi.fn(),
		copy: vi.fn(),
		delete: vi.fn(),
		editUserMessagePreserveResponses: vi.fn(),
		editWithBranching: vi.fn(),
		editWithReplacement: vi.fn(),
		forkConversation: vi.fn(),
		navigateToSibling: vi.fn(),
		regenerateCompaction: vi.fn(),
		regenerateWithBranching: vi.fn()
	};
}

beforeEach(() => {
	settingsStore.updateMultipleConfig({ showMessageStats: true, showRawOutputSwitch: false });
});

afterEach(async () => {
	chatStore.cleanupStreaming('footer-conversation');
	chatStore.activity.applyRemoteSnapshot([]);
	chatStore.activity.endCompacting('footer-conversation');
	chatStore.processing.setActiveConversation(null);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	modelsStore.models = [];
	modelsStore.clearSelection();
	serverStore.role = null;
	vi.restoreAllMocks();
	await page.viewport(1280, 900);
});

describe.runIf(IS_PICO_BUILD)('Pico response footer', () => {
	function activate(assistant: DatabaseMessage) {
		conversationsStore.activeConversation = {
			currNode: assistant.id,
			id: assistant.convId,
			lastModified: 123,
			name: 'Footer test'
		};
		conversationsStore.activeMessages = [assistant];
		chatStore.processing.setActiveConversation(assistant.convId);
	}

	it('shows Processing only before decoding and restores response actions after completion', async () => {
		const assistant = { ...message(), content: '', timings: undefined };

		activate(assistant);
		chatStore.setChatLoading(assistant.convId, true);
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			isLastAssistantMessage: true,
			message: assistant
		});

		await expect.element(screen.getByText('Processing...', { exact: true })).toBeVisible();
		expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		expect(screen.container.querySelector('[aria-label="Response details"]')).toBeNull();
		chatStore.setChatStreaming(assistant.convId, '', assistant.id);
		await screen.rerender({
			message: { ...assistant, reasoningContent: 'Consider the question.' }
		});
		await expect.element(screen.getByText('Thinking', { exact: true })).toBeVisible();
		expect(screen.container.textContent).not.toContain('Processing');
		expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		await screen.rerender({
			message: {
				...assistant,
				content: 'The answer is streaming.',
				reasoningContent: 'Consider it.'
			}
		});
		await expect
			.element(screen.getByText('The answer is streaming.', { exact: true }))
			.toBeVisible();
		expect(screen.container.textContent).not.toContain('Processing');
		expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		chatStore.cleanupStreaming(assistant.convId);
		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
		await expect.element(screen.getByRole('button', { exact: true, name: 'Retry' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'More message actions' }))
			.toBeVisible();
	});

	it.each(['content', 'reasoningContent'] as const)(
		'hides Processing at the first whitespace %s token despite retained prompt progress',
		async (field) => {
			const assistant = { ...message(), content: '', timings: undefined };

			activate(assistant);
			chatStore.processing.restoreFromMessages([message()], assistant.convId);
			chatStore.setChatLoading(assistant.convId, true);
			const screen = render(PicoMessageFooterHarness, {
				chatActions: actions(),
				isLastAssistantMessage: true,
				message: assistant
			});

			await expect.element(screen.getByText('Processing...', { exact: true })).toBeVisible();
			chatStore.processing.applyStreamTimings(
				undefined,
				{ cache: 0, processed: 50, time_ms: 100, total: 100 },
				assistant.convId
			);
			await expect.element(screen.getByText('Processing 50%', { exact: true })).toBeVisible();
			await screen.rerender({ message: { ...assistant, [field]: ' ' } });
			await expect.poll(() => screen.container.textContent).not.toContain('Processing');
			expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		}
	);

	it('keeps a completed response actionable while a new question prepares its placeholder', async () => {
		const assistant = message();

		activate(assistant);
		conversationsStore.activeMessages = [assistant, message(MessageRole.USER)];
		chatStore.setChatLoading(assistant.convId, true);
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			isLastAssistantMessage: true,
			message: assistant
		});

		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
	});

	it('hides the grouped root actions while a later tool turn streams', async () => {
		const assistant = message();
		const nextTurn = { ...assistant, content: 'Finishing the answer.', id: 'next-turn' };

		activate(assistant);
		conversationsStore.activeMessages = [assistant, nextTurn];
		chatStore.setChatStreaming(assistant.convId, nextTurn.content, nextTurn.id);
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			isLastAssistantMessage: true,
			message: assistant,
			toolMessages: [nextTurn]
		});

		await expect.element(screen.getByText(nextTurn.content, { exact: true })).toBeVisible();
		expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		expect(screen.container.textContent).not.toContain('Processing');
		chatStore.cleanupStreaming(assistant.convId);
		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
	});

	it('waits for a remote response to finish and leaves older response actions available', async () => {
		const assistant = message();

		activate(assistant);
		chatStore.activity.applyRemoteSnapshot([assistant.convId]);
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			isLastAssistantMessage: true,
			message: assistant
		});

		await expect.poll(() => screen.container.querySelector('.pico-message-actions')).toBeNull();
		await screen.rerender({ isLastAssistantMessage: false });
		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
		await screen.rerender({ isLastAssistantMessage: true });
		await expect.poll(() => screen.container.querySelector('.pico-message-actions')).toBeNull();
		chatStore.activity.applyRemoteSnapshot([]);
		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
	});

	it('hides actions on an older response when Continue targets that response', async () => {
		const assistant = message();

		activate(assistant);
		conversationsStore.activeMessages = [assistant, { ...assistant, id: 'newer-response' }];
		chatStore.setChatStreaming(assistant.convId, assistant.content, assistant.id);
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			isLastAssistantMessage: false,
			message: assistant
		});

		expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		chatStore.cleanupStreaming(assistant.convId);
		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
	});

	it('hides response details while an untimestamped response streams', async () => {
		const assistant = { ...message(), timestamp: 0 };

		activate(assistant);
		chatStore.setChatLoading(assistant.convId, true);
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			isLastAssistantMessage: true,
			message: assistant
		});

		expect(screen.container.querySelector('[aria-label="Response details"]')).toBeNull();
		chatStore.cleanupStreaming(assistant.convId);
		await expect.element(screen.getByRole('button', { name: 'Response details' })).toBeVisible();
	});

	it('keeps prefill off user messages and exposes only the primary user actions', async () => {
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			message: message(MessageRole.USER),
			nextAssistantMessage: message()
		});

		await expect.element(screen.getByRole('button', { exact: true, name: 'Edit' })).toBeVisible();
		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'More message actions' }))
			.toBeVisible();
		expect(screen.container.textContent).not.toContain('tokens/s');
		expect(screen.container.querySelector('[aria-label="Response details"]')).toBeNull();
		expect(screen.container.querySelector('[aria-label="Delete"]')).toBeNull();
	});

	it('groups both speeds with the response and keeps provenance inert', async () => {
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, { chatActions, message: message() });

		await expect.element(screen.getByRole('button', { exact: true, name: 'Copy' })).toBeVisible();
		await expect.element(screen.getByRole('button', { exact: true, name: 'Retry' })).toBeVisible();
		expect(screen.container.textContent).toContain('Prefill 1,200 tok/s');
		expect(screen.container.textContent).toContain('Decode 40 tok/s');
		await screen.getByRole('button', { name: 'Response details' }).click();
		await expect.element(page.getByText('example/model-q4', { exact: true })).toBeVisible();
		expect(chatActions.regenerateWithBranching).not.toHaveBeenCalled();
	});

	it('retries without a confirmation and retains version navigation', async () => {
		const chatActions = actions();
		const assistant = message();
		const screen = render(PicoMessageFooterHarness, {
			chatActions,
			message: assistant,
			siblingInfo: {
				currentIndex: 0,
				message: assistant,
				siblingIds: [assistant.id, 'version-2'],
				totalSiblings: 2
			}
		});

		await screen.getByRole('button', { exact: true, name: 'Retry' }).click();
		expect(chatActions.regenerateWithBranching).toHaveBeenCalledWith(assistant, undefined);
		await screen.getByRole('button', { name: 'Next version' }).click();
		expect(chatActions.navigateToSibling).toHaveBeenCalledWith('version-2');
	});

	it('reveals the combined speeds when the response receives keyboard focus', async () => {
		const screen = render(PicoMessageFooterHarness, { chatActions: actions(), message: message() });
		const copy = screen.container.querySelector<HTMLButtonElement>('[aria-label="Copy"]');
		const metrics = screen.container.querySelector('.pico-response-metrics');

		copy?.focus();

		expect(metrics).not.toBeNull();
		await expect.poll(() => metrics && getComputedStyle(metrics).opacity).toBe('1');
	});

	it('disables retry and alternate-model actions while a response is generating', async () => {
		const assistant = message();

		conversationsStore.activeConversation = {
			currNode: assistant.id,
			id: assistant.convId,
			lastModified: 123,
			name: 'Footer test'
		};
		serverStore.role = ServerRole.ROUTER;
		chatStore.setChatLoading(assistant.convId, true);
		const load = vi.spyOn(modelsStore.status, 'load').mockResolvedValue(undefined);
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, { chatActions, message: assistant });

		await expect.element(screen.getByRole('button', { exact: true, name: 'Retry' })).toBeDisabled();
		await screen.getByRole('button', { name: 'More message actions' }).click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Retry with another model...' }))
			.toHaveAttribute('aria-disabled', 'true');
		expect(load).not.toHaveBeenCalled();
		expect(chatActions.regenerateWithBranching).not.toHaveBeenCalled();
	});

	it('guards an already-open alternate-model picker when generation starts', async () => {
		const assistant = message();

		conversationsStore.activeConversation = {
			currNode: assistant.id,
			id: assistant.convId,
			lastModified: 123,
			name: 'Footer test'
		};
		conversationsStore.activeMessages = [assistant];
		serverStore.role = ServerRole.ROUTER;
		vi.spyOn(ModelsService, 'list').mockResolvedValue({
			data: [{ id: assistant.model }, { id: 'example/other' }]
		} as never);
		modelsStore.models = [assistant.model!, 'example/other'].map((id) => ({
			capabilities: [],
			id,
			model: id,
			name: id
		}));
		const load = vi.spyOn(modelsStore.status, 'load').mockResolvedValue(undefined);
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, { chatActions, message: assistant });

		await screen.getByRole('button', { name: 'More message actions' }).click();
		await page.getByRole('menuitem', { name: 'Retry with another model...' }).click();
		await expect
			.element(page.getByRole('dialog', { name: 'Retry with another model' }))
			.toBeVisible();
		const pickerTrigger = page
			.getByRole('dialog', { name: 'Retry with another model' })
			.getByRole('button', { name: /model/i });

		await pickerTrigger.click();
		await expect.element(page.getByRole('option', { name: /other/ })).toBeVisible();

		chatStore.setChatLoading(assistant.convId, true);
		await expect.element(pickerTrigger).toBeDisabled();
		await page.getByRole('option', { name: /other/ }).click();
		expect(load).not.toHaveBeenCalled();
		expect(chatActions.regenerateWithBranching).not.toHaveBeenCalled();
	});

	it('keeps right-click Retry disabled while generating and branches in one step', async () => {
		const assistant = message();

		conversationsStore.activeConversation = {
			currNode: assistant.id,
			id: assistant.convId,
			lastModified: 123,
			name: 'Footer test'
		};
		chatStore.setChatLoading(assistant.convId, true);
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, {
			chatActions,
			isLastAssistantMessage: true,
			message: assistant
		});

		expect(screen.container.querySelector('.pico-message-actions')).toBeNull();
		await screen.getByText('A short message.', { exact: true }).click({ button: 'right' });
		await expect
			.element(page.getByRole('menuitem', { exact: true, name: 'Retry' }))
			.toHaveAttribute('aria-disabled', 'true');
		expect(chatActions.regenerateWithBranching).not.toHaveBeenCalled();
		await page.getByRole('menuitem', { name: 'Branch into new chat' }).click();
		await expect.poll(() => vi.mocked(chatActions.forkConversation).mock.calls.length).toBe(1);
		expect(chatActions.forkConversation).toHaveBeenCalledWith(assistant, {
			includeAttachments: true,
			name: 'Branch of Footer test'
		});
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
	});

	it('keeps descendant-aware deletion behind More and its existing confirmation', async () => {
		vi.spyOn(chatStore, 'getDeletionInfo').mockResolvedValue({
			assistantMessages: 1,
			messageTypes: ['message'],
			totalCount: 2,
			userMessages: 1
		});
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, { chatActions, message: message() });

		await screen.getByRole('button', { name: 'More message actions' }).click();
		await page.getByRole('menuitem', { name: 'Delete message' }).click();
		await expect.element(page.getByRole('alertdialog', { name: 'Delete Message' })).toBeVisible();
		expect(chatActions.delete).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Delete 2 Messages' }).click();
		expect(chatActions.delete).toHaveBeenCalledOnce();
	});

	it('opens details on touch with a comfortable target', async () => {
		await page.viewport(390, 844);
		const screen = render(PicoMessageFooterHarness, { chatActions: actions(), message: message() });
		const trigger = screen.container.querySelector('[aria-label="Response details"]');

		expect(trigger?.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
		await screen.getByRole('button', { name: 'Response details' }).click();
		await expect.element(page.getByText('1,200 tok/s', { exact: true })).toBeVisible();
		await expect.element(page.getByText('40 tok/s', { exact: true })).toBeVisible();
	});
});

describe('response timing provenance', () => {
	it('uses cumulative agentic timings instead of the first LLM call', async () => {
		const assistant = message();

		assistant.timings = {
			...timings,
			agentic: {
				llm: { predicted_ms: 1000, predicted_n: 30, prompt_ms: 1000, prompt_n: 300 },
				toolCalls: [],
				toolCallsCount: 2,
				toolsMs: 1000,
				turns: 2
			}
		};
		const screen = render(PicoResponseDetails, {
			isLoading: false,
			message: assistant,
			processingState,
			showMessageStats: true
		});

		expect(screen.container.textContent).toContain('Prefill 300 tok/s');
		expect(screen.container.textContent).toContain('Decode 30 tok/s');
	});

	it('uses summary request timings rather than the post-compaction prompt size', () => {
		const summary = message();

		summary.timings = {
			...timings,
			compaction: { predicted_ms: 2000, predicted_n: 50, prompt_ms: 2000, prompt_n: 4000 }
		};
		const screen = render(PicoResponseDetails, {
			isLoading: false,
			message: summary,
			processingState,
			showMessageStats: true
		});

		expect(screen.container.textContent).toContain('Prefill 2,000 tok/s');
		expect(screen.container.textContent).toContain('Decode 25 tok/s');
	});

	it('prefers the running agentic flow totals over persisted partial timings', () => {
		const assistant = message();

		vi.spyOn(agenticStore, 'getFlowRootMessageId').mockReturnValue(assistant.id);
		vi.spyOn(agenticStore, 'getLiveLlmTotals').mockReturnValue({
			predicted_ms: 1000,
			predicted_n: 35,
			prompt_ms: 2000,
			prompt_n: 1000
		});
		const screen = render(PicoResponseDetails, {
			isLoading: true,
			message: assistant,
			processingState,
			showMessageStats: true
		});

		expect(screen.container.textContent).toContain('Prefill 500 tok/s');
		expect(screen.container.textContent).toContain('Decode 35 tok/s');
	});

	it('keeps model details available when statistics are disabled', async () => {
		const screen = render(PicoResponseDetails, {
			isLoading: false,
			message: message(),
			processingState,
			showMessageStats: false
		});

		expect(screen.container.textContent).not.toContain('tok/s');
		await screen.getByRole('button', { name: 'Response details' }).click();
		await expect.element(page.getByText('example/model-q4', { exact: true })).toBeVisible();
	});

	it('omits unavailable speeds instead of fabricating zeros', () => {
		const assistant = message();

		assistant.timings = undefined;
		const screen = render(PicoResponseDetails, {
			isLoading: false,
			message: assistant,
			processingState,
			showMessageStats: true
		});

		expect(screen.container.textContent).not.toContain('tok/s');
	});
});

describe.skipIf(IS_PICO_BUILD)('generic message footer', () => {
	it('preserves the existing user reading statistics and response actions', async () => {
		const screen = render(PicoMessageFooterHarness, {
			chatActions: actions(),
			message: message(MessageRole.USER),
			nextAssistantMessage: message()
		});

		expect(screen.container.textContent).toContain('tokens/s');
		await expect.element(screen.getByRole('button', { exact: true, name: 'Delete' })).toBeVisible();
	});
});
