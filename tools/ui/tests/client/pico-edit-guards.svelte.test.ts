import PicoEditGateHarness from './components/PicoEditGateHarness.svelte';
import PicoMessageFooterHarness from './components/PicoMessageFooterHarness.svelte';
import { IS_PICO_BUILD } from '$lib/constants';
import { AttachmentType, MessageRole, MessageType, ServerRole } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { chatStore, conversationsStore, modelsStore, serverStore } from '$lib/stores';
import type {
	ChatMessageActions,
	ChatUploadedFile,
	DatabaseMessage,
	ExportedConversation
} from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const ORIGIN = 'pico-edit-guards';

function actions(): ChatMessageActions {
	return {
		continueAssistantMessage: vi.fn(),
		copy: vi.fn(),
		delete: vi.fn(),
		editUserMessagePreserveResponses: vi.fn(),
		editWithBranching: vi.fn(),
		editWithReplacement: (message, text, branch) =>
			chatStore.editAssistantMessage(message.id, text, branch),
		forkConversation: vi.fn(),
		navigateToSibling: vi.fn(),
		regenerateCompaction: vi.fn(),
		regenerateWithBranching: vi.fn()
	};
}

async function persistedAssistant() {
	const user: DatabaseMessage = {
		children: ['edit-answer'],
		content: 'Question',
		convId: ORIGIN,
		id: 'edit-question',
		parent: 'edit-root',
		role: MessageRole.USER,
		timestamp: 1,
		type: MessageType.TEXT
	};
	const assistant: DatabaseMessage = {
		children: [],
		content: 'Saved response',
		convId: ORIGIN,
		extra: [{ content: 'Saved attachment', name: 'saved.txt', type: AttachmentType.TEXT }],
		id: 'edit-answer',
		model: 'example/model',
		parent: user.id,
		reasoningContent: 'Saved reasoning',
		role: MessageRole.ASSISTANT,
		timestamp: 2,
		timings: { predicted_ms: 1000, predicted_n: 25 },
		toolCalls: '[]',
		type: MessageType.TEXT
	};
	const root = {
		...user,
		children: [user.id],
		content: '',
		id: 'edit-root',
		parent: null,
		type: 'root'
	} as DatabaseMessage;

	await DatabaseService.importConversations([
		{
			conv: { currNode: assistant.id, id: ORIGIN, lastModified: 2, name: 'Edit guards' },
			messages: [root, user, assistant]
		} as ExportedConversation
	]);
	conversationsStore.activeConversation = (await DatabaseService.getConversation(ORIGIN))!;
	conversationsStore.activeMessages = [user, assistant];

	return { assistant, user };
}

beforeEach(() => {
	serverStore.role = ServerRole.MODEL;
	serverStore.error = null;
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
});

afterEach(async () => {
	chatStore.setChatLoading(ORIGIN, false);
	chatStore.setChatLoading('edit-gate-origin', false);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	modelsStore.models = [];
	modelsStore.clearSelection();
	serverStore.role = null;
	vi.restoreAllMocks();
	await DatabaseService.deleteConversation(ORIGIN);
});

describe.runIf(IS_PICO_BUILD)('Pico edit guards', () => {
	it('disables edit entry for a generating origin chat', async () => {
		const { assistant, user } = await persistedAssistant();

		chatStore.setChatLoading(ORIGIN, true);
		const chatActions = actions();
		const userScreen = render(PicoMessageFooterHarness, { chatActions, message: user });

		await expect
			.element(userScreen.getByRole('button', { exact: true, name: 'Edit' }))
			.toBeDisabled();
		await userScreen.unmount();
		const assistantScreen = render(PicoMessageFooterHarness, { chatActions, message: assistant });

		await assistantScreen.getByRole('button', { name: 'More message actions' }).click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Edit response' }))
			.toHaveAttribute('aria-disabled', 'true');
	});

	it('keeps an open edit draft until origin generation ends and preserves saved metadata', async () => {
		const { assistant } = await persistedAssistant();
		const screen = render(PicoMessageFooterHarness, { chatActions: actions(), message: assistant });

		await screen.getByRole('button', { name: 'More message actions' }).click();
		await page.getByRole('menuitem', { name: 'Edit response' }).click();
		await screen.getByRole('textbox').fill('Edited response');
		chatStore.setChatLoading(ORIGIN, true);
		await expect
			.element(screen.getByRole('button', { exact: true, name: 'Save response' }))
			.toBeDisabled();
		await expect.element(screen.getByRole('textbox')).toHaveValue('Edited response');
		let saved = (await DatabaseService.getConversationMessages(ORIGIN)).find(
			(entry) => entry.id === assistant.id
		)!;

		expect(saved.content).toBe('Saved response');
		expect(saved.extra).toEqual(assistant.extra);
		expect(saved.reasoningContent).toBe(assistant.reasoningContent);
		chatStore.setChatLoading(ORIGIN, false);
		await screen.getByRole('button', { exact: true, name: 'Save response' }).click();
		await expect
			.poll(
				async () =>
					(await DatabaseService.getConversationMessages(ORIGIN)).find(
						(entry) => entry.id === assistant.id
					)?.content
			)
			.toBe('Edited response');
		saved = (await DatabaseService.getConversationMessages(ORIGIN)).find(
			(entry) => entry.id === assistant.id
		)!;
		expect(saved.extra).toEqual(assistant.extra);
		expect(saved.reasoningContent).toBe(assistant.reasoningContent);
		expect(saved.timings).toEqual(assistant.timings);
		expect(saved.model).toBe(assistant.model);
	});

	it('waits for loading prompt attachments before allowing Send changes', async () => {
		const file = new File(['Prompt text'], 'prompt.txt', { type: 'text/plain' });
		const pending: ChatUploadedFile = {
			file,
			id: 'pending-prompt',
			isLoading: true,
			name: file.name,
			size: file.size,
			type: file.type
		};
		const onSave = vi.fn();
		const screen = render(PicoEditGateHarness, { files: [pending], onSave });

		await expect.element(screen.getByRole('button', { name: 'Send changes' })).toBeDisabled();
		expect(onSave).not.toHaveBeenCalled();
		await screen.rerender({
			files: [{ ...pending, isLoading: false, textContent: 'Prompt text' }],
			onSave
		});
		await screen.getByRole('button', { name: 'Send changes' }).click();
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('requires an available future model for prompt edits', async () => {
		serverStore.role = ServerRole.ROUTER;
		modelsStore.models = [];
		modelsStore.selectedModelId = 'missing';
		modelsStore.selectedModelName = 'missing';
		vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
		const onSave = vi.fn();
		const screen = render(PicoEditGateHarness, { onSave });

		await expect.element(screen.getByRole('button', { name: 'Send changes' })).toBeDisabled();
		modelsStore.models = [
			{ capabilities: [], id: 'available', model: 'available', name: 'Available' }
		];
		await screen.getByRole('button', { name: 'Model for the next response' }).click();
		await page.getByRole('option', { name: /^available/i }).click();
		expect(modelsStore.selectedModelName).toBe('available');
		await screen.getByRole('button', { name: 'Send changes' }).click();
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('keeps the chosen future model when the prompt editor mounts', async () => {
		const { assistant } = await persistedAssistant();

		serverStore.role = ServerRole.ROUTER;
		modelsStore.models = [
			{ capabilities: [], id: assistant.model!, model: assistant.model!, name: 'Previous model' },
			{ capabilities: [], id: 'future-model', model: 'future-model', name: 'Future model' }
		];
		modelsStore.selectedModelId = 'future-model';
		modelsStore.selectedModelName = 'future-model';
		vi.spyOn(modelsStore, 'fetch').mockResolvedValue();
		const onSave = vi.fn();
		const screen = render(PicoEditGateHarness, { onSave });

		await expect
			.element(screen.getByRole('button', { name: 'Model for the next response' }))
			.toHaveTextContent('future model');
		expect(modelsStore.selectedModelName).toBe('future-model');
		await screen.getByRole('button', { name: 'Send changes' }).click();
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('allows assistant saves independently of model availability', async () => {
		serverStore.role = ServerRole.ROUTER;
		modelsStore.models = [];
		modelsStore.clearSelection();
		const onSave = vi.fn();
		const screen = render(PicoEditGateHarness, { onSave, role: MessageRole.ASSISTANT });

		await screen.getByRole('button', { exact: true, name: 'Save response' }).click();
		expect(onSave).toHaveBeenCalledOnce();
	});
});
