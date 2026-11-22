<script lang="ts">
	import { Info } from '@lucide/svelte';
	import * as Popover from '$lib/components/ui/popover';
	import type { UseProcessingStateReturn } from '$lib/hooks/use-processing-state.svelte';
	import { agenticStore } from '$lib/stores';
	import type { DatabaseMessage } from '$lib/types';
	import { formatPerformanceTime } from '$lib/utils';

	interface Props {
		message: DatabaseMessage;
		isLoading: boolean;
		processingState: UseProcessingStateReturn;
		showMessageStats: boolean;
	}

	let { isLoading, message, processingState, showMessageStats }: Props = $props();

	const liveLlm = $derived(agenticStore.getLiveLlmTotals(message.convId));
	const isLiveFlowRoot = $derived(
		liveLlm !== null && agenticStore.getFlowRootMessageId(message.convId) === message.id
	);
	const timings = $derived.by(() => {
		if (isLiveFlowRoot && liveLlm) return liveLlm;

		if (message.timings?.compaction) return message.timings.compaction;

		if (message.timings?.agentic) return message.timings.agentic.llm;

		if (message.timings?.predicted_n || !isLoading) return message.timings;

		const prompt = processingState.getLiveProcessingStats();
		const generation = processingState.getLiveGenerationStats();

		return {
			predicted_ms: generation?.timeMs,
			predicted_n: generation?.tokensGenerated,
			prompt_ms: prompt?.timeMs,
			prompt_n: prompt?.tokensProcessed
		};
	});

	function speed(tokens: number | undefined, milliseconds: number | undefined): string | null {
		if (
			!tokens ||
			!milliseconds ||
			tokens < 0 ||
			milliseconds < 0 ||
			!Number.isFinite(tokens / milliseconds)
		)
			return null;

		return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
			(tokens / milliseconds) * 1000
		);
	}

	const prefill = $derived(showMessageStats ? speed(timings?.prompt_n, timings?.prompt_ms) : null);
	const decode = $derived(
		showMessageStats ? speed(timings?.predicted_n, timings?.predicted_ms) : null
	);
</script>

{#if message.model || prefill || decode}
	<div class="pico-response-details flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
		<span class="pico-response-metrics hidden flex-wrap items-center gap-x-3 tabular-nums md:flex">
			{#if prefill}<span>Prefill {prefill} tok/s</span>{/if}

			{#if decode}<span>Decode {decode} tok/s</span>{/if}
		</span>

		<Popover.Root>
			<Popover.Trigger
				aria-label="Response details"
				class="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:size-8"
				title="Response details"
			>
				<Info class="size-4" />
			</Popover.Trigger>

			<Popover.Content align="end" class="w-72 max-w-[calc(100vw-2rem)] text-sm">
				<p class="mb-3 font-medium">Response details</p>

				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
					{#if message.model}
						<dt class="text-muted-foreground">Model</dt>

						<dd class="min-w-0 break-words">{message.model}</dd>
					{/if}

					{#if prefill}
						<dt class="text-muted-foreground">Prefill</dt>

						<dd class="tabular-nums">{prefill} tok/s</dd>

						<dt class="text-muted-foreground">Input</dt>

						<dd class="tabular-nums">{timings?.prompt_n?.toLocaleString()} tokens</dd>

						<dt class="text-muted-foreground">Processing time</dt>

						<dd>{formatPerformanceTime(timings?.prompt_ms ?? 0)}</dd>
					{/if}

					{#if decode}
						<dt class="text-muted-foreground">Decode</dt>

						<dd class="tabular-nums">{decode} tok/s</dd>

						<dt class="text-muted-foreground">Output</dt>

						<dd class="tabular-nums">{timings?.predicted_n?.toLocaleString()} tokens</dd>

						<dt class="text-muted-foreground">Generation time</dt>

						<dd>{formatPerformanceTime(timings?.predicted_ms ?? 0)}</dd>
					{/if}
				</dl>
			</Popover.Content>
		</Popover.Root>
	</div>
{/if}

<style>
	@media (width <= 768px), (pointer: coarse) {
		.pico-response-details :global([data-slot='popover-trigger']) {
			min-height: 44px;
			min-width: 44px;
		}
	}

	@media (hover: hover) and (pointer: fine) {
		.pico-response-metrics {
			opacity: 0;
			transition: opacity 150ms;
		}

		:global(.chat-message-assistant:hover) .pico-response-metrics,
		:global(.chat-message-assistant:focus-within) .pico-response-metrics,
		.pico-response-details:hover .pico-response-metrics,
		.pico-response-details:focus-within .pico-response-metrics {
			opacity: 1;
		}
	}
</style>
