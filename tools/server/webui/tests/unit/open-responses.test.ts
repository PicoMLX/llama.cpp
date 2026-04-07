import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenResponsesService } from '$lib/services/open-responses';
import { AGENTIC_TAGS, REASONING_TAGS } from '$lib/constants/agentic';
import type { ChatMessageTimings } from '$lib/types/chat';

// Fixtures mirror the current Pico AI Server Open Responses contract from:
// - PicoServer/HTTP Server/Services/OpenResponses/OpenResponsesGenerationService.swift
// - PicoOpenResponses/Sources/OpenResponses/Models/ResponseObject.swift
const fixturesDir = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'fixtures',
	'open-responses'
);

const completedResponseFixture = JSON.parse(
	readFileSync(resolve(fixturesDir, 'pico-completed-response.json'), 'utf8')
) as Record<string, unknown>;

const completedStreamFixture = readFileSync(
	resolve(fixturesDir, 'pico-completed-response.sse'),
	'utf8'
);

const toolInvocationStreamFixture = `event: response.reasoning.delta
data: {"type":"response.reasoning.delta","delta":"Inspecting whether a tool is needed."}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fc_123","type":"function_call","callId":"call_123","name":"web_search"},"output_index":1}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_123","output_index":1,"delta":"{\\"query\\":\\"weather sf\\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","item_id":"fc_123","output_index":1,"arguments":"{\\"query\\":\\"weather sf\\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_123","type":"function_call","callId":"call_123","name":"web_search"},"output_index":1}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fco_123","type":"function_call_output","callId":"call_123","output":"{\\"forecast\\":\\"sunny\\"}"},"output_index":2}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fco_123","type":"function_call_output","callId":"call_123","output":"{\\"forecast\\":\\"sunny\\"}"},"output_index":2}

event: response.reasoning.delta
data: {"type":"response.reasoning.delta","delta":"Using the tool result to answer."}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"It is sunny."}

event: response.completed
data: {"type":"response.completed","response":{"model":"Ministral-3-8B","usage":{"input_tokens":12,"output_tokens":7,"input_tokens_details":{"cached_tokens":0},"prompt_time_ms":100,"generation_time_ms":200}}}

data: [DONE]
`;

const externalToolCallPendingStreamFixture = `event: response.reasoning.delta
data: {"type":"response.reasoning.delta","delta":"I should look this up."}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fc_456","type":"function_call","callId":"call_456","name":"web_search"},"output_index":1}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_456","output_index":1,"delta":"{\\"query\\":\\"weather sf\\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","item_id":"fc_456","output_index":1,"arguments":"{\\"query\\":\\"weather sf\\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_456","type":"function_call","callId":"call_456","name":"web_search"},"output_index":1}

event: response.completed
data: {"type":"response.completed","response":{"model":"Ministral-3-8B","usage":{"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":0},"prompt_time_ms":100,"generation_time_ms":200}}}

data: [DONE]
`;

const streamedTopLevelErrorFixture = `event: error
data: {"type":"error","code":"not_found","message":"Model not found"}

data: [DONE]
`;

const streamedNestedErrorFixture = `event: error
data: {"type":"error","error":{"code":"server_error","message":"Nested stream failure"}}

data: [DONE]
`;

const streamedFailedResponseFixture = `event: response.failed
data: {"type":"response.failed","response":{"error":{"code":"conflict","message":"Model download is incomplete."}}}

data: [DONE]
`;

const streamedIncompleteCancellationFixture = `event: response.incomplete
data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"cancelled"}}}

data: [DONE]
`;

function createStreamResponse(body: string): Response {
	const encoder = new TextEncoder();

	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			}
		}),
		{ status: 200 }
	);
}

describe('OpenResponsesService', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('maps the real Pico AI Server non-stream usage contract including timing ms', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(completedResponseFixture), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		let capturedTimings: ChatMessageTimings | undefined;
		const content = await OpenResponsesService.sendMessage(
			[{ role: 'user', content: 'Hi' }],
			{
				stream: false,
				onComplete: (
					_response: string,
					_reasoning?: string,
					timings?: ChatMessageTimings
				) => {
					capturedTimings = timings;
				}
			}
		);

		expect(content).toBe("Because they don't have the guts!");
		expect(capturedTimings).toEqual({
			prompt_n: 18,
			predicted_n: 9,
			cache_n: 2,
			prompt_ms: 16188.945889472961,
			predicted_ms: 40704.0079832077
		});
	});

	it('maps the real Pico AI Server stream completion payload including timing ms', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(completedStreamFixture));
		vi.stubGlobal('fetch', fetchMock);

		const timingUpdates: ChatMessageTimings[] = [];
		let streamedText = '';
		let completedTimings: ChatMessageTimings | undefined;

		await OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
			stream: true,
			onChunk: (chunk: string) => {
				streamedText += chunk;
			},
			onTimings: (timings?: ChatMessageTimings) => {
				if (timings) {
					timingUpdates.push(timings);
				}
			},
			onComplete: (
				_response: string,
				_reasoning?: string,
				timings?: ChatMessageTimings
			) => {
				completedTimings = timings;
			}
		});

		expect(streamedText).toBe("Because they don't have the guts!");
		expect(timingUpdates).toEqual([
			{
				prompt_n: 18,
				predicted_n: 9,
				cache_n: 2,
				prompt_ms: 16188.945889472961,
				predicted_ms: 40704.0079832077
			}
		]);
		expect(completedTimings).toEqual({
			prompt_n: 18,
			predicted_n: 9,
			cache_n: 2,
			prompt_ms: 16188.945889472961,
			predicted_ms: 40704.0079832077
		});
	});

	it('interleaves reasoning and completed tool output for streamed internal Responses tools', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(toolInvocationStreamFixture));
		vi.stubGlobal('fetch', fetchMock);

		let streamedContent = '';
		let completedContent = '';

		await OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
			stream: true,
			onChunk: (chunk: string) => {
				streamedContent += chunk;
			},
			onComplete: (response: string) => {
				completedContent = response;
			}
		});

		const expectedContent =
			`${REASONING_TAGS.START}Inspecting whether a tool is needed.${REASONING_TAGS.END}` +
			`${AGENTIC_TAGS.TOOL_CALL_START}\n<<<TOOL_NAME:web_search>>>\n${AGENTIC_TAGS.TOOL_ARGS_START}{"query":"weather sf"}${AGENTIC_TAGS.TOOL_ARGS_END}\n{"forecast":"sunny"}\n${AGENTIC_TAGS.TOOL_CALL_END}\n` +
			`${REASONING_TAGS.START}Using the tool result to answer.${REASONING_TAGS.END}` +
			'It is sunny.';

		expect(streamedContent).toBe(expectedContent);
		expect(completedContent).toBe(expectedContent);
	});

	it('keeps unmatched streamed Responses function calls pending for external tool handoff', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(createStreamResponse(externalToolCallPendingStreamFixture));
		vi.stubGlobal('fetch', fetchMock);

		let streamedContent = '';
		let completedContent = '';

		await OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
			stream: true,
			onChunk: (chunk: string) => {
				streamedContent += chunk;
			},
			onComplete: (response: string) => {
				completedContent = response;
			}
		});

		const expectedContent =
			`${REASONING_TAGS.START}I should look this up.${REASONING_TAGS.END}` +
			`${AGENTIC_TAGS.TOOL_CALL_START}\n<<<TOOL_NAME:web_search>>>\n${AGENTIC_TAGS.TOOL_ARGS_START}{"query":"weather sf"}${AGENTIC_TAGS.TOOL_ARGS_END}`;

		expect(streamedContent).toBe(expectedContent);
		expect(completedContent).toBe(expectedContent);
	});

	it('maps non-stream Responses function_call items into agentic content instead of throwing', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					model: 'Ministral-3-8B',
					output: [
						{
							id: 'fc_123',
							type: 'function_call',
							name: 'web_search',
							arguments: {
								query: 'weather sf'
							}
						}
					],
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						input_tokens_details: {
							cached_tokens: 0
						},
						prompt_time_ms: 100,
						generation_time_ms: 200
					}
				}),
				{ status: 200 }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const content = await OpenResponsesService.sendMessage(
			[{ role: 'user', content: 'Hi' }],
			{
				stream: false
			}
		);

		expect(content).toBe(
			`${AGENTIC_TAGS.TOOL_CALL_START}\n<<<TOOL_NAME:web_search>>>\n${AGENTIC_TAGS.TOOL_ARGS_START}{"query":"weather sf"}${AGENTIC_TAGS.TOOL_ARGS_END}${AGENTIC_TAGS.TOOL_CALL_END}`
		);
	});

	it('preserves pre-stream non-200 JSON errors', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: 'Bad request before streaming' } }), {
				status: 400
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
				stream: true,
				onError,
				onComplete
			})
		).rejects.toThrow('Bad request before streaming');

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('surfaces top-level streamed error events and does not complete', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(streamedTopLevelErrorFixture));
		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
				stream: true,
				onError,
				onComplete
			})
		).rejects.toThrow('Model not found');

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe('Model not found');
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('accepts nested streamed error payloads during rollout and does not complete', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(streamedNestedErrorFixture));
		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
				stream: true,
				onError,
				onComplete
			})
		).rejects.toThrow('Nested stream failure');

		expect(onError).toHaveBeenCalledTimes(1);
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe('Nested stream failure');
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('surfaces response.failed terminal errors and does not complete', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(streamedFailedResponseFixture));
		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
				stream: true,
				onError,
				onComplete
			})
		).rejects.toThrow('Model download is incomplete.');

		expect(onError).toHaveBeenCalledTimes(1);
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
			'Model download is incomplete.'
		);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('treats response.incomplete cancellations as non-success without surfacing an error', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(createStreamResponse(streamedIncompleteCancellationFixture));
		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ role: 'user', content: 'Hi' }], {
				stream: true,
				onError,
				onComplete
			})
		).resolves.toBeUndefined();

		expect(onError).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});
});
