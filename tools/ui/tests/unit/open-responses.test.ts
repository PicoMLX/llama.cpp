import { OpenResponsesService } from '$lib/services/open-responses';
import type { ChatMessageTimings } from '$lib/types/chat';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fixtures mirror the current Pico AI Server Open Responses contract from:
// - PicoServer/HTTP Server/Services/OpenResponses/OpenResponsesGenerationService.swift
// - PicoOpenResponses/Sources/OpenResponses/Models/ResponseObject.swift
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-responses');
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

		const content = await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onComplete: (_response: string, _reasoning?: string, timings?: ChatMessageTimings) => {
				capturedTimings = timings;
			},
			stream: false
		});

		expect(content).toBe("Because they don't have the guts!");
		expect(capturedTimings).toEqual({
			cache_n: 2,
			predicted_ms: 40704.0079832077,
			predicted_n: 9,
			prompt_ms: 16188.945889472961,
			prompt_n: 18
		});
	});

	it('maps the real Pico AI Server stream completion payload including timing ms', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(completedStreamFixture));

		vi.stubGlobal('fetch', fetchMock);

		const timingUpdates: ChatMessageTimings[] = [];

		let streamedText = '';
		let completedTimings: ChatMessageTimings | undefined;

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onChunk: (chunk: string) => {
				streamedText += chunk;
			},
			onComplete: (_response: string, _reasoning?: string, timings?: ChatMessageTimings) => {
				completedTimings = timings;
			},
			onTimings: (timings?: ChatMessageTimings) => {
				if (timings) {
					timingUpdates.push(timings);
				}
			},
			stream: true
		});

		expect(streamedText).toBe("Because they don't have the guts!");
		expect(timingUpdates).toEqual([
			{
				cache_n: 2,
				predicted_ms: 40704.0079832077,
				predicted_n: 9,
				prompt_ms: 16188.945889472961,
				prompt_n: 18
			}
		]);
		expect(completedTimings).toEqual({
			cache_n: 2,
			predicted_ms: 40704.0079832077,
			predicted_n: 9,
			prompt_ms: 16188.945889472961,
			prompt_n: 18
		});
	});

	it('keeps reasoning separate and clears completed internal Responses tools', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(toolInvocationStreamFixture));

		vi.stubGlobal('fetch', fetchMock);

		let streamedContent = '';
		let completedContent = '';
		let streamedReasoning = '';
		let completedReasoning: string | undefined;

		const toolCallUpdates: string[] = [];

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onChunk: (chunk: string) => {
				streamedContent += chunk;
			},
			onComplete: (response: string, reasoning?: string) => {
				completedContent = response;
				completedReasoning = reasoning;
			},
			onReasoningChunk: (chunk: string) => {
				streamedReasoning += chunk;
			},
			onToolCallChunk: (serialized: string) => {
				toolCallUpdates.push(serialized);
			},
			stream: true
		});

		expect(streamedContent).toBe('It is sunny.');
		expect(completedContent).toBe('It is sunny.');
		expect(streamedReasoning).toBe(
			'Inspecting whether a tool is needed.Using the tool result to answer.'
		);
		expect(completedReasoning).toBe(streamedReasoning);
		expect(toolCallUpdates.at(-1)).toBe('[]');
	});

	it('keeps unmatched streamed Responses function calls pending for external tool handoff', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(createStreamResponse(externalToolCallPendingStreamFixture));

		vi.stubGlobal('fetch', fetchMock);

		let streamedContent = '';
		let completedContent = '';
		let streamedReasoning = '';
		let latestToolCalls = '';

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onChunk: (chunk: string) => {
				streamedContent += chunk;
			},
			onComplete: (response: string) => {
				completedContent = response;
			},
			onReasoningChunk: (chunk: string) => {
				streamedReasoning += chunk;
			},
			onToolCallChunk: (serialized: string) => {
				latestToolCalls = serialized;
			},
			stream: true
		});

		expect(streamedContent).toBe('');
		expect(completedContent).toBe('');
		expect(streamedReasoning).toBe('I should look this up.');
		expect(JSON.parse(latestToolCalls)).toEqual([
			{
				function: { arguments: '{"query":"weather sf"}', name: 'web_search' },
				id: 'call_456',
				index: 0,
				type: 'function'
			}
		]);
	});

	it('maps non-stream Responses function_call items into structured tool calls', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					model: 'Ministral-3-8B',
					output: [
						{
							arguments: {
								query: 'weather sf'
							},
							id: 'fc_123',
							name: 'web_search',
							type: 'function_call'
						}
					],
					usage: {
						generation_time_ms: 200,
						input_tokens: 12,
						input_tokens_details: {
							cached_tokens: 0
						},
						output_tokens: 0,
						prompt_time_ms: 100
					}
				}),
				{ status: 200 }
			)
		);

		vi.stubGlobal('fetch', fetchMock);

		let latestToolCalls = '';

		const content = await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			onToolCallChunk: (serialized: string) => {
				latestToolCalls = serialized;
			},
			stream: false
		});

		expect(content).toBe('');
		expect(JSON.parse(latestToolCalls)).toEqual([
			{
				function: { arguments: '{"query":"weather sf"}', name: 'web_search' },
				id: 'fc_123',
				index: 0,
				type: 'function'
			}
		]);
	});

	it('converts structured assistant and tool history into Responses input items', () => {
		const input = OpenResponsesService.convertMessagesToInput([
			{ content: 'Be concise.', role: 'system' },
			{ content: 'What is the weather?', role: 'user' },
			{
				content: '',
				reasoning_content: 'I need current data.',
				role: 'assistant',
				tool_calls: [
					{
						function: { arguments: '{"city":"SF"}', name: 'weather' },
						id: 'call_weather',
						index: 0,
						type: 'function'
					}
				]
			},
			{ content: '{"condition":"sunny"}', role: 'tool', tool_call_id: 'call_weather' }
		]);

		expect(input).toEqual([
			{ content: 'Be concise.', role: 'developer' },
			{ content: 'What is the weather?', role: 'user' },
			{ content: '', role: 'assistant', status: 'completed', type: 'message' },
			{
				content: [{ text: 'I need current data.', type: 'reasoning_text' }],
				summary: [],
				type: 'reasoning'
			},
			{
				arguments: '{"city":"SF"}',
				call_id: 'call_weather',
				name: 'weather',
				type: 'function_call'
			},
			{
				call_id: 'call_weather',
				output: '{"condition":"sunny"}',
				type: 'function_call_output'
			}
		]);

		expect(
			OpenResponsesService.convertMessagesToInput(
				[
					{
						content: 'Done.',
						reasoning_content: 'Private reasoning.',
						role: 'assistant'
					}
				],
				true
			)
		).toEqual([{ content: 'Done.', role: 'assistant', status: 'completed', type: 'message' }]);
	});

	it('sends flattened function tools and llama sampling options to v1/responses', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'resp_123',
					output: [
						{
							content: [{ text: 'Done.', type: 'output_text' }],
							type: 'message'
						}
					]
				}),
				{ status: 200 }
			)
		);

		vi.stubGlobal('fetch', fetchMock);

		await OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
			max_tokens: 0,
			stream: false,
			tools: [
				{
					function: {
						description: 'Get current weather',
						name: 'weather',
						parameters: { properties: {}, type: 'object' }
					},
					type: 'function'
				}
			],
			top_k: 40
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe('./v1/responses');
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(request.body as string);

		expect(body.max_output_tokens).toBe(-1);
		expect(body.top_k).toBe(40);
		expect(body.reasoning).toEqual({ effort: 'medium' });
		expect(body.tools).toEqual([
			{
				description: 'Get current weather',
				name: 'weather',
				parameters: { properties: {}, type: 'object' },
				type: 'function'
			}
		]);
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
			OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
				onComplete,
				onError,
				stream: true
			})
		).rejects.toThrow('Bad request before streaming');

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('reports non-stream response parse errors once', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));

		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
				onError,
				stream: false
			})
		).rejects.toBeInstanceOf(Error);

		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('surfaces top-level streamed error events and does not complete', async () => {
		const fetchMock = vi.fn().mockResolvedValue(createStreamResponse(streamedTopLevelErrorFixture));

		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
				onComplete,
				onError,
				stream: true
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
			OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
				onComplete,
				onError,
				stream: true
			})
		).rejects.toThrow('Nested stream failure');

		expect(onError).toHaveBeenCalledTimes(1);
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe('Nested stream failure');
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('surfaces response.failed terminal errors and does not complete', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(createStreamResponse(streamedFailedResponseFixture));

		vi.stubGlobal('fetch', fetchMock);

		const onError = vi.fn();
		const onComplete = vi.fn();

		await expect(
			OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
				onComplete,
				onError,
				stream: true
			})
		).rejects.toThrow('Model download is incomplete.');

		expect(onError).toHaveBeenCalledTimes(1);
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe('Model download is incomplete.');
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
			OpenResponsesService.sendMessage([{ content: 'Hi', role: 'user' }], {
				onComplete,
				onError,
				stream: true
			})
		).resolves.toBeUndefined();

		expect(onError).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});
});
