import type { ChatMessageTimings } from '$lib/types';

export function createReasoningTiming(allowWallClock = true) {
	let startedAt: number | undefined;
	let generationBeforeReasoning = 0;
	let previousGeneration = 0;
	let reasoningGeneration: number | undefined;
	let duration: number | undefined;

	function apply(timings: ChatMessageTimings | undefined): ChatMessageTimings | undefined {
		return duration === undefined ? timings : { ...timings, reasoning_ms: duration };
	}

	function finish(timings: ChatMessageTimings | undefined): ChatMessageTimings | undefined {
		if (startedAt !== undefined) {
			const elapsed =
				reasoningGeneration !== undefined
					? Math.max(0, reasoningGeneration - generationBeforeReasoning)
					: allowWallClock
						? Math.max(0, performance.now() - startedAt)
						: undefined;

			if (elapsed !== undefined) duration = (duration ?? 0) + elapsed;

			startedAt = undefined;
			reasoningGeneration = undefined;
		}

		return apply(timings);
	}

	return {
		apply,
		finish,
		update(reasoning: boolean, output: boolean, timings: ChatMessageTimings | undefined) {
			const previousDuration = duration;
			const predictedMs = timings?.predicted_ms;

			if (reasoning) {
				if (startedAt === undefined) {
					startedAt = performance.now();
					generationBeforeReasoning = previousGeneration;
				}

				if (typeof predictedMs === 'number' && Number.isFinite(predictedMs)) {
					reasoningGeneration = predictedMs;
				}
			}

			if (output) finish(timings);

			if (typeof predictedMs === 'number' && Number.isFinite(predictedMs)) {
				previousGeneration = predictedMs;
			}

			return !timings && previousDuration === duration ? undefined : apply(timings);
		}
	};
}
