import PicoActivityHarness from './components/PicoActivityHarness.svelte';
import PicoInstructionsHarness from './components/PicoInstructionsHarness.svelte';
import PicoMessageFooterHarness from './components/PicoMessageFooterHarness.svelte';
import { SYSTEM_MESSAGE_PLACEHOLDER } from '$lib/constants';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import {
	AttachmentType,
	BuiltInTool,
	MessageRole,
	MessageType,
	ServerRole,
	ToolPermissionDecision
} from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import {
	agenticStore,
	chatStore,
	conversationsStore,
	serverStore,
	settingsStore
} from '$lib/stores';
import type { ChatMessageActions, DatabaseMessage } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

function message(role = MessageRole.ASSISTANT): DatabaseMessage {
	return {
		children: [],
		content: 'Original message',
		convId: 'pico-edit-activity',
		id: role,
		parent: null,
		role,
		timestamp: 123,
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

function toolMessage(toolName = 'custom_tool'): DatabaseMessage {
	return {
		...message(),
		content: '',
		toolCalls: JSON.stringify([
			{ function: { arguments: '{"path":"notes.txt"}', name: toolName }, id: 'call-1' }
		])
	};
}

function toolResult(content: string): DatabaseMessage {
	return { ...message(MessageRole.TOOL), content, id: 'result-1', toolCallId: 'call-1' };
}

beforeEach(() => {
	vi.spyOn(DatabaseService, 'versionForEdit').mockResolvedValue(7);
	serverStore.role = ServerRole.MODEL;
	settingsStore.updateMultipleConfig({
		alwaysShowToolCallContent: true,
		showThoughtInProgress: true,
		showToolCallInProgress: true
	});
});

afterEach(() => {
	chatStore.clearPendingEditMessageId();
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	serverStore.role = null;
	vi.restoreAllMocks();
});

describe.runIf(IS_PICO_BUILD)('Pico chat instructions', () => {
	function openInstructions(content: string) {
		const system = { ...message(MessageRole.SYSTEM), content, type: MessageRole.SYSTEM };
		const user = message(MessageRole.USER);
		const messages = [system, user];

		settingsStore.updateConfig('showSystemMessage', false);
		conversationsStore.activeConversation = {
			currNode: user.id,
			id: system.convId,
			lastModified: 123,
			name: 'Instructions test'
		};
		conversationsStore.activeMessages = messages;
		vi.spyOn(conversationsStore, 'getConversationMessages').mockResolvedValue(messages);
		chatStore.pendingEditMessageId = system.id;
		const screen = render(PicoInstructionsHarness, { messages });

		return { screen, system };
	}

	it('opens instructions on demand while keeping system content out of the transcript', async () => {
		const update = vi.spyOn(DatabaseService, 'updateMessage').mockResolvedValue();
		const { screen, system } = openInstructions('Keep answers concise');

		await expect
			.element(page.getByRole('dialog', { exact: true, name: 'Chat instructions' }))
			.toBeVisible();
		expect(screen.container.querySelector('[aria-label="System message with actions"]')).toBeNull();
		expect(
			screen.container.querySelector('.chat-message--instructions')?.getBoundingClientRect().height
		).toBe(0);
		await page
			.getByRole('textbox', { exact: true, name: 'Chat instructions' })
			.fill('Use clear examples');
		await page.getByRole('button', { exact: true, name: 'Save instructions' }).click();
		await expect.poll(() => update.mock.calls.length).toBe(1);
		expect(update).toHaveBeenCalledWith(
			system.id,
			{ content: 'Use clear examples' },
			{ ifVersion: 7 }
		);
		expect(settingsStore.config.showSystemMessage).toBe(false);
	});

	it('cleans up a new instruction placeholder when its dialog is cancelled', async () => {
		const remove = vi.spyOn(chatStore, 'removeSystemPromptPlaceholder').mockResolvedValue(false);
		const { system } = openInstructions(SYSTEM_MESSAGE_PLACEHOLDER);

		await expect
			.element(page.getByRole('dialog', { exact: true, name: 'Chat instructions' }))
			.toBeVisible();
		await page.getByRole('button', { exact: true, name: 'Cancel' }).click();
		await expect.poll(() => remove.mock.calls.length).toBe(1);
		expect(remove).toHaveBeenCalledWith(system.id);
	});
});

describe.runIf(IS_PICO_BUILD)('Pico message editing', () => {
	it('sends prompt edits through the version-preserving path with existing attachments', async () => {
		const user = message(MessageRole.USER);

		user.extra = [{ content: 'saved attachment', name: 'notes.txt', type: AttachmentType.TEXT }];
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, { chatActions, message: user });

		await screen.getByRole('button', { exact: true, name: 'Edit' }).click();
		await screen.getByRole('textbox').fill('Updated question');
		expect(screen.container.textContent).not.toContain('Update without re-sending');
		await screen.getByRole('button', { name: 'Send changes' }).click();
		await expect.poll(() => vi.mocked(chatActions.editWithBranching).mock.calls.length).toBe(1);
		expect(chatActions.editWithBranching).toHaveBeenCalledWith(
			user,
			'Updated question',
			user.extra,
			7
		);
		expect(chatActions.editUserMessagePreserveResponses).not.toHaveBeenCalled();
	});

	it('labels assistant edits as a save to the existing response', async () => {
		const assistant = message();
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, { chatActions, message: assistant });

		await screen.getByRole('button', { name: 'More message actions' }).click();
		await page.getByRole('menuitem', { name: 'Edit response' }).click();
		await screen.getByRole('textbox').fill('Updated response');
		await expect.element(screen.getByText('Edits this saved response.')).toBeVisible();
		expect(screen.container.textContent).not.toContain('Branch conversation after edit');
		await screen.getByRole('button', { name: 'Save response' }).click();
		expect(chatActions.editWithReplacement).toHaveBeenCalledWith(
			assistant,
			'Updated response',
			false,
			7
		);
	});

	it('retains the existing discard protection for changed drafts', async () => {
		const chatActions = actions();
		const screen = render(PicoMessageFooterHarness, {
			chatActions,
			message: message(MessageRole.USER)
		});

		await screen.getByRole('button', { exact: true, name: 'Edit' }).click();
		await screen.getByRole('textbox').fill('Unsaved edit');
		await screen.getByRole('button', { exact: true, name: 'Cancel' }).click();
		await expect.element(page.getByRole('alertdialog', { name: 'Discard changes?' })).toBeVisible();
		await page.getByRole('button', { name: 'Keep editing' }).click();
		await expect.element(screen.getByRole('textbox')).toHaveValue('Unsaved edit');
		expect(chatActions.editWithBranching).not.toHaveBeenCalled();
	});
});

describe.runIf(IS_PICO_BUILD)('Pico activity disclosure', () => {
	it('collapses thinking despite old saved display preferences and preserves manual expansion', async () => {
		const thinking = { ...message(), content: '', reasoningContent: 'thinking-body-marker' };
		const screen = render(PicoActivityHarness, { isStreaming: true, message: thinking });

		await expect.element(screen.getByText('Thinking...', { exact: true })).toBeVisible();
		expect(screen.container.textContent).not.toContain('thinking-body-marker');
		await screen.getByText('Thinking...', { exact: true }).click();
		await expect.element(screen.getByText('thinking-body-marker')).toBeVisible();
		await screen.rerender({
			isStreaming: true,
			message: { ...thinking, reasoningContent: 'thinking-body-marker continued' }
		});
		await expect.element(screen.getByText('thinking-body-marker continued')).toBeVisible();
	});

	it('keeps tool headings visible while raw tool output starts collapsed', async () => {
		const tool = toolMessage();
		const screen = render(PicoActivityHarness, {
			message: tool,
			toolMessages: [toolResult('raw-tool-marker')]
		});

		await expect.element(screen.getByText('custom_tool', { exact: true })).toBeVisible();
		expect(screen.container.textContent).not.toContain('raw-tool-marker');
		await screen.getByText('custom_tool', { exact: true }).click();
		await expect.element(screen.getByText('raw-tool-marker', { exact: true })).toBeVisible();
	});

	it('keeps failed and interrupted status headings visible without opening raw details', async () => {
		const screen = render(PicoActivityHarness, {
			message: toolMessage(BuiltInTool.SERVER_WRITE_FILE),
			toolMessages: [toolResult('{"error":"Permission denied"}')]
		});

		expect(screen.container.textContent).toContain('failed');
		await screen.rerender({ message: toolMessage(), toolMessages: [] });
		expect(screen.container.textContent).toContain('interrupted');
	});

	it('shows permission choices outside the collapsed tool body', async () => {
		vi.spyOn(agenticStore, 'getPendingPermissionRequest').mockReturnValue({
			serverLabel: 'Example app',
			toolName: 'custom_tool'
		});
		const resolve = vi.spyOn(agenticStore, 'resolvePermission').mockImplementation(() => {});
		const tool = toolMessage();
		const screen = render(PicoActivityHarness, { isStreaming: true, message: tool });

		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Allow once' }))
			.toBeVisible();
		await screen.getByRole('button', { exact: true, name: 'Allow once' }).click();
		expect(resolve).toHaveBeenCalledWith(tool.convId, ToolPermissionDecision.ONCE);
	});

	it('keeps the continue decision outside collapsed activity', async () => {
		vi.spyOn(agenticStore, 'getPendingContinueRequest').mockReturnValue(true);
		const resolve = vi.spyOn(agenticStore, 'resolveContinue').mockImplementation(() => {});
		const tool = toolMessage();
		const screen = render(PicoActivityHarness, { isStreaming: true, message: tool });

		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Continue' }))
			.toBeVisible();
		await screen.getByRole('button', { exact: true, name: 'Continue' }).click();
		expect(resolve).toHaveBeenCalledWith(tool.convId, true);
	});
});

describe.skipIf(IS_PICO_BUILD)('generic activity disclosure', () => {
	it('continues honoring the existing expanded-tool preference', async () => {
		const screen = render(PicoActivityHarness, {
			message: toolMessage(),
			toolMessages: [toolResult('generic-tool-marker')]
		});

		await expect.element(screen.getByText('generic-tool-marker', { exact: true })).toBeVisible();
	});
});
