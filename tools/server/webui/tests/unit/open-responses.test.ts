import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenResponsesService } from '$lib/services/open-responses';
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
});
