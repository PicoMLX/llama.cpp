<script lang="ts">
	import { Clock, Gauge, WholeWord, BookOpenText, Sparkles } from '@lucide/svelte';
	import { BadgeChatStatistic } from '$lib/components/app';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { ChatMessageStatsView } from '$lib/enums';
	import { t } from '$lib/i18n';
	import { formatPerformanceTime } from '$lib/utils';
	import { MS_PER_SECOND, DEFAULT_PERFORMANCE_TIME } from '$lib/constants/formatters';

	interface Props {
		predictedTokens?: number;
		predictedMs?: number;
		promptTokens?: number;
		promptMs?: number;
		isLive?: boolean;
		isProcessingPrompt?: boolean;
		initialView?: ChatMessageStatsView;
		onActiveViewChange?: (view: ChatMessageStatsView) => void;
	}

	let {
		predictedTokens,
		predictedMs,
		promptTokens,
		promptMs,
		isLive = false,
		isProcessingPrompt = false,
		initialView = ChatMessageStatsView.GENERATION,
		onActiveViewChange
	}: Props = $props();

	let activeView: ChatMessageStatsView = $derived(initialView);
	let hasAutoSwitchedToGeneration = $state(false);

	$effect(() => {
		onActiveViewChange?.(activeView);
	});

	// In live mode: auto-switch to GENERATION tab when prompt processing completes
	$effect(() => {
		if (isLive) {
			// Auto-switch to generation tab only when prompt processing is done (once)
			if (
				!hasAutoSwitchedToGeneration &&
				!isProcessingPrompt &&
				predictedTokens &&
				predictedTokens > 0
			) {
				activeView = ChatMessageStatsView.GENERATION;
				hasAutoSwitchedToGeneration = true;
			} else if (!hasAutoSwitchedToGeneration) {
				// Stay on READING while prompt is still being processed
				activeView = ChatMessageStatsView.READING;
			}
		}
	});

	let hasGenerationStats = $derived(
		predictedTokens !== undefined &&
			predictedTokens > 0 &&
			predictedMs !== undefined &&
			predictedMs > 0
	);

	let tokensPerSecond = $derived(
		hasGenerationStats ? (predictedTokens! / predictedMs!) * MS_PER_SECOND : 0
	);
	let formattedTime = $derived(
		predictedMs !== undefined ? formatPerformanceTime(predictedMs) : DEFAULT_PERFORMANCE_TIME
	);

	let promptTokensPerSecond = $derived(
		promptTokens !== undefined && promptMs !== undefined && promptMs > 0
			? (promptTokens / promptMs) * MS_PER_SECOND
			: undefined
	);

	let formattedPromptTime = $derived(
		promptMs !== undefined ? formatPerformanceTime(promptMs) : undefined
	);

	let hasPromptStats = $derived(
		promptTokens !== undefined &&
			promptMs !== undefined &&
			promptTokensPerSecond !== undefined &&
			formattedPromptTime !== undefined
	);

	// In live mode, generation tab is disabled until we have generation stats
	let isGenerationDisabled = $derived(isLive && !hasGenerationStats);
</script>

<div class="inline-flex items-center text-xs text-muted-foreground">
	<div class="inline-flex items-center rounded-sm bg-muted-foreground/15 p-0.5">
		{#if hasPromptStats || isLive}
			<Tooltip.Root>
				<Tooltip.Trigger>
					<button
						type="button"
						class="inline-flex h-5 w-5 items-center justify-center rounded-sm transition-colors {activeView ===
						ChatMessageStatsView.READING
							? 'bg-background text-foreground shadow-sm'
							: 'hover:text-foreground'}"
						onclick={() => (activeView = ChatMessageStatsView.READING)}
					>
						<BookOpenText class="h-3 w-3" />
						<span class="sr-only">{t('chat.stats.reading')}</span>
					</button>
				</Tooltip.Trigger>

				<Tooltip.Content>
					<p>{t('chat.stats.reading_tooltip')}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		{/if}
		<Tooltip.Root>
			<Tooltip.Trigger>
				<button
					type="button"
					class="inline-flex h-5 w-5 items-center justify-center rounded-sm transition-colors {activeView ===
					ChatMessageStatsView.GENERATION
						? 'bg-background text-foreground shadow-sm'
						: isGenerationDisabled
							? 'cursor-not-allowed opacity-40'
							: 'hover:text-foreground'}"
					onclick={() => !isGenerationDisabled && (activeView = ChatMessageStatsView.GENERATION)}
					disabled={isGenerationDisabled}
				>
					<Sparkles class="h-3 w-3" />
					<span class="sr-only">{t('chat.stats.generation')}</span>
				</button>
			</Tooltip.Trigger>

			<Tooltip.Content>
				<p>
					{isGenerationDisabled
						? t('chat.stats.generation_waiting')
						: t('chat.stats.generation_tooltip')}
				</p>
			</Tooltip.Content>
		</Tooltip.Root>
	</div>

	<div class="flex items-center gap-1 px-2">
		{#if activeView === ChatMessageStatsView.GENERATION && hasGenerationStats}
			<BadgeChatStatistic
				class="bg-transparent"
				icon={WholeWord}
				value={t('chat.stats.value.tokens', {
					count: predictedTokens?.toLocaleString() ?? '0'
				})}
				tooltipLabel={t('chat.stats.generated_tokens')}
			/>

			<BadgeChatStatistic
				class="bg-transparent"
				icon={Clock}
				value={formattedTime}
				tooltipLabel={t('chat.stats.generation_time')}
			/>

			<BadgeChatStatistic
				class="bg-transparent"
				icon={Gauge}
				value={t('chat.stats.value.tokens_per_second', {
					value: tokensPerSecond.toFixed(2)
				})}
				tooltipLabel={t('chat.stats.generation_speed')}
			/>
		{:else if hasPromptStats}
			<BadgeChatStatistic
				class="bg-transparent"
				icon={WholeWord}
				value={t('chat.stats.value.tokens', {
					count: promptTokens?.toLocaleString() ?? '0'
				})}
				tooltipLabel={t('chat.stats.prompt_tokens')}
			/>

			<BadgeChatStatistic
				class="bg-transparent"
				icon={Clock}
				value={formattedPromptTime ?? '0s'}
				tooltipLabel={t('chat.stats.prompt_time')}
			/>

			<BadgeChatStatistic
				class="bg-transparent"
				icon={Gauge}
				value={t('chat.stats.value.tokens_per_second', {
					value: promptTokensPerSecond!.toFixed(2)
				})}
				tooltipLabel={t('chat.stats.prompt_speed')}
			/>
		{/if}
	</div>
</div>
