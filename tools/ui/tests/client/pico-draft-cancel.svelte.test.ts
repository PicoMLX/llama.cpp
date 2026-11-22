import '../../src/app.css';
import PicoInstructionsHarness from './components/PicoInstructionsHarness.svelte';
import { IS_PICO_BUILD, SYSTEM_MESSAGE_PLACEHOLDER } from '$lib/constants';
import { MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { chatStore, conversationsStore, draftMessagesStore } from '$lib/stores';
import type { ChatUploadedFile } from '$lib/types';
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

let conversationId: string | undefined;

function attachment(name: string, content: string): ChatUploadedFile {
	const file = new File([content], name, { type: 'text/plain' });

	return { file, id: name, name, size: file.size, type: file.type };
}

beforeEach(async () => {
	await DatabaseService.useStore(localChatStore);
	conversationsStore.clearActiveConversation();
	chatStore.clearPendingEditMessageId();
	draftMessagesStore.clearDraftMessage(undefined);
});

afterEach(async () => {
	chatStore.clearEditMode();
	chatStore.clearPendingEditMessageId();
	conversationsStore.clearActiveConversation();
	draftMessagesStore.clearDraftMessage(undefined);

	if (conversationId) {
		draftMessagesStore.clearDraftMessage(conversationId);
		await DatabaseService.deleteConversation(conversationId);
	}

	conversationId = undefined;
	vi.restoreAllMocks();
});

describe.runIf(IS_PICO_BUILD)('cancel Instructions after another New chat draft', () => {
	it('keeps both drafts and attachments when the New chat slot is occupied', async () => {
		const fileA = attachment('draft-a.txt', 'Attachment A');
		const fileB = attachment('draft-b.txt', 'Attachment B');

		draftMessagesStore.saveDraftMessage(undefined, 'Draft A', [fileA]);
		await chatStore.addSystemPrompt({ files: [fileA], message: 'Draft A' });
		const id = conversationsStore.activeConversation!.id;

		conversationId = id;
		const placeholder = conversationsStore.activeMessages.find(
			(message) => message.content === SYSTEM_MESSAGE_PLACEHOLDER
		)!;

		chatStore.clearPendingEditMessageId();
		conversationsStore.clearActiveConversation();
		draftMessagesStore.saveDraftMessage(undefined, 'Draft B', [fileB]);
		expect(await conversationsStore.loadConversation(id)).toBe(true);
		chatStore.pendingEditMessageId = placeholder.id;
		render(PicoInstructionsHarness, { messages: conversationsStore.activeMessages });
		const dialog = page.getByRole('dialog', { name: 'Chat instructions' });

		await expect.element(dialog).toBeVisible();
		await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await expect
			.poll(async () => (await DatabaseService.getConversationMessages(id)).length)
			.toBe(1);
		expect(await DatabaseService.getConversation(id)).toBeDefined();
		const draftA = draftMessagesStore.getDraftMessage(id);
		const draftB = draftMessagesStore.getDraftMessage(undefined);

		expect(draftA.message).toBe('Draft A');
		expect(draftA.files[0].id).toBe(fileA.id);
		expect(await draftA.files[0].file.text()).toBe('Attachment A');
		expect(draftB.message).toBe('Draft B');
		expect(draftB.files[0].id).toBe(fileB.id);
		expect(await draftB.files[0].file.text()).toBe('Attachment B');
		const root = (await DatabaseService.getConversationMessages(id))[0];

		await DatabaseService.createMessageBranch(
			{
				children: [],
				content: draftA.message,
				convId: id,
				role: MessageRole.USER,
				timestamp: Date.now(),
				type: MessageType.TEXT
			},
			root.id
		);
		const payload = await ChatService.normalizeMessagesForApi(
			await DatabaseService.getConversationMessages(id)
		);

		expect(payload).toEqual([{ content: 'Draft A', role: MessageRole.USER }]);
	});
});
