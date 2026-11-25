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
	it('notifies once per active phase even when its duration is unknown or unchanged', () => {
		const ended = vi.fn();
		const timing = createReasoningTiming(false, ended);

		timing.finish(undefined);
		expect(ended).not.toHaveBeenCalled();
		timing.update(true, false, undefined);
		timing.finish(undefined);
		timing.finish(undefined);
		expect(ended).toHaveBeenCalledTimes(1);
		timing.update(true, false, { predicted_ms: 1000 });
		timing.update(false, true, { predicted_ms: 2000 });
		expect(ended).toHaveBeenCalledTimes(2);
		timing.update(true, false, { predicted_ms: 2000 });
		timing.update(true, false, { predicted_ms: 2000 });
		expect(ended).toHaveBeenCalledTimes(2);
		timing.update(false, true, { predicted_ms: 2000 });
		timing.finish(undefined);
		expect(ended).toHaveBeenCalledTimes(3);
	});

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
	it('does not introduce reasoning-end events into the generic stream', async () => {
		const ended = vi.fn();
		const response = new Response(
			`data: ${JSON.stringify({
				choices: [{ delta: { reasoning_content: 'Thought' } }]
			})}\n\ndata: [DONE]\n\n`
		);

		await ChatService.handleStreamResponse(
			response,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			ended
		);

		expect(ended).not.toHaveBeenCalled();
	});

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
	it('ends reasoning after a mixed reasoning and tool-call delta exactly once', async () => {
		const response = new Response(
			`data: ${JSON.stringify({
				choices: [
					{
						delta: {
							reasoning_content: 'Use the tool',
							tool_calls: [
								{
									function: { arguments: '{}', name: 'example' },
									id: 'call-1',
									index: 0,
									type: 'function'
								}
							]
						}
					}
				]
			})}\n\ndata: [DONE]\n\n`
		);
		const events: string[] = [];

		await ChatService.handleStreamResponse(
			response,
			undefined,
			undefined,
			undefined,
			() => {
				events.push('reasoning');
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			() => {
				events.push('end');
			}
		);

		expect(events).toEqual(['reasoning', 'end']);
	});

	it('leaves a combined reasoning and answer delta in the answer phase', async () => {
		const response = new Response(
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer', reasoning_content: 'Thought' } }] })}\n\ndata: [DONE]\n\n`
		);

		let thinking = false;

		await ChatService.handleStreamResponse(
			response,
			() => {
				thinking = false;
			},
			undefined,
			undefined,
			() => {
				thinking = true;
			}
		);

		expect(thinking).toBe(false);
	});

	it('ends an unknown replay phase before answer output without inventing a duration', async () => {
		const events: string[] = [];
		const response = new Response(
			[
				{ choices: [{ delta: { reasoning_content: 'Thought' } }] },
				{ choices: [{ delta: { content: 'Answer' } }] }
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join('') + 'data: [DONE]\n\n'
		);

		let completed: ChatMessageTimings | undefined;

		await ChatService.handleStreamResponse(
			response,
			() => events.push('answer'),
			(_text, _reasoning, timings) => {
				completed = timings;
			},
			undefined,
			() => events.push('reasoning'),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			() => events.push('end')
		);

		expect(events).toEqual(['reasoning', 'end', 'answer']);
		expect(completed).toBeUndefined();
	});

	it('does not end a second phase when its chunks carry the first phase duration', async () => {
		const events: string[] = [];
		const chunks = [
			{ choices: [{ delta: { reasoning_content: 'First' } }], timings: { predicted_ms: 1000 } },
			{ choices: [{ delta: { content: 'Interim' } }], timings: { predicted_ms: 2000 } },
			{ choices: [{ delta: { reasoning_content: 'Second' } }], timings: { predicted_ms: 3000 } },
			{ choices: [{ delta: { reasoning_content: ' more' } }], timings: { predicted_ms: 4000 } },
			{ choices: [{ delta: { content: 'Answer' } }], timings: { predicted_ms: 5000 } }
		];
		const response = new Response(
			chunks.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
		);

		await ChatService.handleStreamResponse(
			response,
			() => events.push('answer'),
			undefined,
			undefined,
			() => events.push('reasoning'),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			() => events.push('end')
		);

		expect(events).toEqual([
			'reasoning',
			'end',
			'answer',
			'reasoning',
			'reasoning',
			'end',
			'answer'
		]);
	});

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
		const ended = vi.fn();
		const events = [
			{ delta: 'Thought', timings: { predicted_ms: 2500 }, type: 'response.reasoning_text.delta' },
			{ type: 'response.reasoning_text.done' },
			{
				delta: 'More thought',
				timings: { predicted_ms: 2500 },
				type: 'response.reasoning_text.delta'
			},
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
		let endsAtFirstAnswer = 0;

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onChunk: () => {
				durationAtFirstAnswer = latest?.reasoning_ms;
				endsAtFirstAnswer = ended.mock.calls.length;
			},
			onComplete: (
				_text: string,
				_reasoning: string | undefined,
				timings: ChatMessageTimings | undefined
			) => {
				completed = timings;
			},
			onReasoningEnd: ended,
			onTimings: (timings: ChatMessageTimings | undefined) => {
				latest = timings;
			},
			stream: true
		});

		expect(durationAtFirstAnswer).toBe(2500);
		expect(endsAtFirstAnswer).toBe(2);
		expect(ended).toHaveBeenCalledTimes(2);
		expect(completed).toMatchObject({ predicted_n: 20, prompt_n: 10, reasoning_ms: 2500 });
	});
});
