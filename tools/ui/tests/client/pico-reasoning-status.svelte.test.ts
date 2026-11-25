import PicoActivityHarness from './components/PicoActivityHarness.svelte';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { ErrorDialogType, MessageRole, MessageType } from '$lib/enums';
import { agenticStore, chatStore } from '$lib/stores';
import type { DatabaseMessage } from '$lib/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

function message(overrides: Partial<DatabaseMessage> = {}): DatabaseMessage {
	return {
		children: [],
		content: '',
		convId: 'reasoning-status',
		id: 'reasoning-status-assistant',
		parent: null,
		reasoningContent: 'Reasoning body marker',
		role: MessageRole.ASSISTANT,
		timestamp: 123,
		type: MessageType.TEXT,
		...overrides
	};
}

afterEach(() => {
	chatStore.dismissResponseError('reasoning-status');
	chatStore.errorDialogState = null;
	vi.restoreAllMocks();
});

describe.runIf(IS_PICO_BUILD)('Pico reasoning header', () => {
	it('finishes thinking before the answer finishes streaming and keeps the saved duration', async () => {
		const thinking = message();
		const screen = render(PicoActivityHarness, { isStreaming: true, message: thinking });

		await expect.element(screen.getByText('Thinking', { exact: true })).toBeVisible();
		expect(screen.container.querySelector('.lucide-lightbulb')).toBeNull();
		expect(screen.container.textContent).not.toContain('Reasoning body marker');

		const answered = message({
			content: 'The answer is still streaming',
			timings: { reasoning_ms: 3200 }
		});

		await screen.rerender({ isStreaming: true, message: answered });
		await expect.element(screen.getByText('Thought for 3 seconds', { exact: true })).toBeVisible();
		expect(screen.container.querySelector('.shimmer-text')).toBeNull();
		await screen.getByRole('button', { name: 'Thought for 3 seconds Toggle content' }).click();
		await expect.element(screen.getByText('Reasoning body marker')).toBeVisible();

		await screen.rerender({ isStreaming: false, message: structuredClone(answered) });
		await expect.element(screen.getByText('Thought for 3 seconds', { exact: true })).toBeVisible();
	});

	it('stops the thinking label on an explicit reasoning completion before answer text arrives', async () => {
		const screen = render(PicoActivityHarness, { isStreaming: true, message: message() });

		await screen.rerender({
			isStreaming: true,
			message: message({ timings: { reasoning_ms: 800 } })
		});
		await expect.element(screen.getByText('Thought for 1 second', { exact: true })).toBeVisible();
	});

	it('uses Thought for legacy replies without inventing a duration from total decode time', async () => {
		const screen = render(PicoActivityHarness, {
			message: message({ content: 'Saved answer', timings: { predicted_ms: 40_000 } })
		});

		await expect.element(screen.getByText('Thought', { exact: true })).toBeVisible();
		expect(screen.container.textContent).not.toContain('seconds');
	});

	it('keeps cancelled and failed reasoning distinct from completed reasoning', async () => {
		const screen = render(PicoActivityHarness, {
			message: message({ timings: { reasoning_ms: 2000 } })
		});

		await expect.element(screen.getByText('Thinking', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('Cancelled', { exact: true })).toBeVisible();
		vi.spyOn(agenticStore, 'getLastError').mockReturnValue(new Error('Reasoning failed'));
		await screen.rerender({ message: message({ id: 'failed-reasoning' }) });
		await expect.element(screen.getByText('Error', { exact: true })).toBeVisible();
		expect(screen.container.textContent).not.toContain('Thought for');
	});

	it('shows an ordinary stream error only on the response that failed', async () => {
		const failed = message();
		const screen = render(PicoActivityHarness, { message: failed });

		chatStore.showErrorDialog({
			conversationId: failed.convId,
			message: 'The stream failed',
			messageId: failed.id,
			type: ErrorDialogType.SERVER
		});

		await expect.element(screen.getByText('Error', { exact: true })).toBeVisible();
		await screen.rerender({ message: message({ id: 'another-response' }) });
		await expect.element(screen.getByText('Cancelled', { exact: true })).toBeVisible();
		expect(screen.container.textContent).not.toContain('Error');
	});
});

describe.runIf(!IS_PICO_BUILD)('generic reasoning header', () => {
	it('retains the original label and icon', async () => {
		const screen = render(PicoActivityHarness, { isStreaming: true, message: message() });

		await expect.element(screen.getByText('Reasoning...', { exact: true })).toBeVisible();
		expect(screen.container.querySelector('.lucide-lightbulb')).not.toBeNull();
	});
});
