import PicoActivityHarness from './components/PicoActivityHarness.svelte';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { MessageRole, MessageType, ServerRole } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import {
	agenticStore,
	chatStore,
	conversationsStore,
	serverStore,
	settingsStore
} from '$lib/stores';
import type { DatabaseMessage, ExportedConversation, SettingsConfigType } from '$lib/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

let session: ExportedConversation;
let previousConfig: SettingsConfigType;

beforeEach(async () => {
	await DatabaseService.useStore(localChatStore);
	previousConfig = { ...settingsStore.config };
	settingsStore.config = {
		...settingsStore.config,
		apiEndpoint: 'responses',
		customJson: '',
		preEncodeConversation: false
	};
	serverStore.role = ServerRole.MODEL;
	serverStore.props = null;
	const id = `plain-reasoning-${crypto.randomUUID()}`;
	const user: DatabaseMessage = {
		children: [`${id}-reply`],
		content: 'Question',
		convId: id,
		id: `${id}-user`,
		parent: null,
		role: MessageRole.USER,
		timestamp: 1,
		type: MessageType.TEXT
	};
	const assistant: DatabaseMessage = {
		...user,
		children: [],
		content: '',
		id: `${id}-reply`,
		parent: user.id,
		role: MessageRole.ASSISTANT
	};

	session = {
		conv: { currNode: assistant.id, id, lastModified: 1, name: 'Plain reasoning' },
		messages: [user, assistant]
	};
	await DatabaseService.importConversations([session]);
	conversationsStore.activeConversation = { ...session.conv };
	conversationsStore.activeMessages = structuredClone(session.messages);
	chatStore.processing.setActiveConversation(id);
	chatStore.setChatLoading(id, true);
	vi.spyOn(agenticStore, 'runAgenticFlow').mockResolvedValue({ handled: false });
});

afterEach(async () => {
	chatStore.cleanupStreaming(session.conv.id);
	chatStore.dismissResponseError(session.conv.id);
	ChatService.clearStreamState(session.conv.id);
	chatStore.processing.setActiveConversation(null);
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	await DatabaseService.bulkDeleteConversations([session.conv.id]);
	settingsStore.config = previousConfig;
	serverStore.clear();
	vi.restoreAllMocks();
});

describe.runIf(IS_PICO_BUILD)('plain Responses reasoning', () => {
	it.each(['reasoning_text', 'reasoning_summary_text'] as const)(
		'ends Thinking on %s.done before a no-tools response has any answer',
		async (reasoningType) => {
			let controller!: ReadableStreamDefaultController<Uint8Array>;

			const body = new ReadableStream<Uint8Array>({
				start(streamController) {
					controller = streamController;
				}
			});
			const emit = (event: Record<string, unknown>) => {
				controller.enqueue(
					new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				);
			};
			const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
				const url = new URL(
					typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
					window.location.origin
				);

				expect(url.pathname).toBe('/v1/responses');
				expect(init?.method).toBe('POST');

				return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
			});
			const completion = chatStore.streamChatCompletion([session.messages[0]], session.messages[1]);

			try {
				await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
				expect(agenticStore.runAgenticFlow).toHaveBeenCalledOnce();
				emit({
					delta: 'Reasoning body',
					timings: { predicted_ms: 3000 },
					type: `response.${reasoningType}.delta`
				});
				await vi.waitFor(() =>
					expect(conversationsStore.activeMessages[1].reasoningContent).toBe('Reasoning body')
				);
				const screen = render(PicoActivityHarness, {
					isStreaming: true,
					message: conversationsStore.activeMessages[1]
				});

				await expect.element(screen.getByText('Thinking', { exact: true })).toBeVisible();
				emit({ type: `response.${reasoningType}.done` });
				await vi.waitFor(() =>
					expect(conversationsStore.activeMessages[1].timings?.reasoning_ms).toBe(3000)
				);
				await screen.rerender({
					isStreaming: true,
					message: conversationsStore.activeMessages[1]
				});
				expect(conversationsStore.activeMessages[1].content).toBe('');
				expect(chatStore.isChatLoadingInternal(session.conv.id)).toBe(true);
				await expect
					.element(screen.getByText('Thought for 3 seconds', { exact: true }))
					.toBeVisible();
			} finally {
				emit({ delta: 'Answer', type: 'response.output_text.delta' });
				emit({ type: 'response.completed' });
				controller.close();
				await completion;
				await vi.waitFor(() =>
					expect(chatStore.isChatLoadingInternal(session.conv.id)).toBe(false)
				);
			}
		}
	);
});
