import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { ChatService } from '$lib/services/chat.service';
import { OpenResponsesService } from '$lib/services/open-responses';
import type { ChatMessageTimings } from '$lib/types';
import { createReasoningTiming } from '$lib/utils/reasoning-timing';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('reasoning duration', () => {
	it('uses generation timings for replay and excludes prompt and answer time', () => {
		const timing = createReasoningTiming(false);

		timing.update(false, false, { predicted_ms: 0, prompt_ms: 20_000 });
		timing.update(true, false, { predicted_ms: 1000 });
		timing.update(true, false, { predicted_ms: 2500 });
		expect(timing.update(false, true, { predicted_ms: 9000 })).toEqual({
			predicted_ms: 9000,
			reasoning_ms: 2500
		});
		expect(timing.apply({ predicted_ms: 30_000, prompt_n: 123 })).toEqual({
			predicted_ms: 30_000,
			prompt_n: 123,
			reasoning_ms: 2500
		});
	});

	it('counts only observed live reasoning when the provider omits timings', () => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(20_000);
		const timing = createReasoningTiming();

		timing.update(false, false, { prompt_ms: 20_000 });
		clock.mockReturnValue(21_000);
		timing.update(true, false, undefined);
		clock.mockReturnValue(24_000);
		expect(timing.update(false, true, undefined)).toEqual({ reasoning_ms: 3000 });
		clock.mockReturnValue(40_000);
		expect(timing.finish(undefined)).toEqual({ reasoning_ms: 3000 });
	});

	it('keeps replay duration unknown without provider generation timings', () => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
		const timing = createReasoningTiming(false);

		timing.update(true, false, undefined);
		clock.mockReturnValue(5000);
		expect(timing.update(false, true, undefined)).toBeUndefined();
		expect(timing.finish({ predicted_ms: 9000 })).toEqual({ predicted_ms: 9000 });
	});

	it('adds separate reasoning phases without counting intervening output', () => {
		const timing = createReasoningTiming(false);

		timing.update(true, false, { predicted_ms: 2000 });
		timing.update(false, true, { predicted_ms: 3000 });
		timing.update(true, false, { predicted_ms: 4500 });
		expect(timing.update(false, true, { predicted_ms: 7000 })?.reasoning_ms).toBe(3500);
	});
});

describe.runIf(!IS_PICO_BUILD)('generic provider timing fields', () => {
	it('preserves a provider reasoning duration through stream completion', async () => {
		const response = new Response(
			`data: ${JSON.stringify({
				choices: [{ delta: { content: 'Answer' } }],
				timings: { predicted_ms: 9000, reasoning_ms: 2500 }
			})}\n\ndata: [DONE]\n\n`
		);

		let completed: ChatMessageTimings | undefined;

		await ChatService.handleStreamResponse(response, undefined, (_text, _reasoning, timings) => {
			completed = timings;
		});

		expect(completed).toEqual({ predicted_ms: 9000, reasoning_ms: 2500 });
	});
});

describe.runIf(IS_PICO_BUILD)('Pico reasoning stream timings', () => {
	it('publishes the duration before answer chunks and preserves final provider fields', async () => {
		const events = [
			{
				choices: [{ delta: { reasoning_content: 'First thought' } }],
				timings: { predicted_ms: 1000, prompt_ms: 20_000 }
			},
			{
				choices: [{ delta: { reasoning_content: ' more thought' } }],
				timings: { predicted_ms: 2500 }
			},
			{
				choices: [{ delta: { content: ' ' } }],
				timings: { predicted_ms: 4000 }
			},
			{
				choices: [{ delta: { content: 'Answer' } }],
				timings: { predicted_ms: 9000, predicted_n: 200 }
			}
		];
		const response = new Response(
			events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
		);

		let latest: ChatMessageTimings | undefined;
		let completed: ChatMessageTimings | undefined;

		const durationsAtAnswer: (number | undefined)[] = [];

		await ChatService.handleStreamResponse(
			response,
			() => {
				durationsAtAnswer.push(latest?.reasoning_ms);
			},
			(_text, _reasoning, timings) => {
				completed = timings;
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(timings) => {
				latest = timings;
			}
		);

		expect(durationsAtAnswer).toEqual([2500, 2500]);
		expect(completed).toEqual({
			predicted_ms: 9000,
			predicted_n: 200,
			prompt_ms: 20_000,
			reasoning_ms: 2500
		});
	});

	it('retains the observed duration on abort without completing the response', async () => {
		const controller = new AbortController();
		const complete = vi.fn();
		const response = new Response(
			`data: ${JSON.stringify({
				choices: [{ delta: { reasoning_content: 'Partial thought' } }],
				timings: { predicted_ms: 2500 }
			})}\n\n`
		);

		let latest: ChatMessageTimings | undefined;

		await ChatService.handleStreamResponse(
			response,
			undefined,
			complete,
			undefined,
			() => controller.abort(),
			undefined,
			undefined,
			undefined,
			(timings) => {
				latest = timings;
			},
			undefined,
			controller.signal
		);

		expect(latest?.reasoning_ms).toBe(2500);
		expect(complete).not.toHaveBeenCalled();
	});

	it('publishes OpenResponses reasoning completion before the answer and keeps it with usage', async () => {
		const events = [
			{ delta: 'Thought', timings: { predicted_ms: 2500 }, type: 'response.reasoning_text.delta' },
			{ type: 'response.reasoning_text.done' },
			{ delta: 'Answer', type: 'response.output_text.delta' },
			{ response: { usage: { input_tokens: 10, output_tokens: 20 } }, type: 'response.completed' }
		];

		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response(
						events
							.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
							.join('')
					)
				)
		);
		let latest: ChatMessageTimings | undefined;
		let completed: ChatMessageTimings | undefined;
		let durationAtFirstAnswer: number | undefined;

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onChunk: () => {
				durationAtFirstAnswer = latest?.reasoning_ms;
			},
			onComplete: (
				_text: string,
				_reasoning: string | undefined,
				timings: ChatMessageTimings | undefined
			) => {
				completed = timings;
			},
			onTimings: (timings: ChatMessageTimings | undefined) => {
				latest = timings;
			},
			stream: true
		});

		expect(durationAtFirstAnswer).toBe(2500);
		expect(completed).toMatchObject({ predicted_n: 20, prompt_n: 10, reasoning_ms: 2500 });
	});
});
