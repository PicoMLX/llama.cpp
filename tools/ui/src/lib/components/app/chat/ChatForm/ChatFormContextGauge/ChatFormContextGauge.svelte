<script lang="ts">
	import ContextGaugeDial from './ContextGaugeDial.svelte';
	import {
		gaugeTriggerClick,
		gaugeTriggerEnter,
		gaugeTriggerKeydown,
		gaugeTriggerLeave,
		gaugeTriggerPointerDown
	} from './gauge-popup.svelte';
	import { useContextGauge } from '$lib/hooks/use-context-gauge.svelte';
	import { useConversationProcessing } from '$lib/hooks/use-conversation-processing.svelte';
	import { deviceStore } from '$lib/stores';

	const gauge = useContextGauge();
	useConversationProcessing();

	$effect(() => {
		gauge.startMonitoring();
	});
</script>

<div
	aria-label="Context usage"
	class="flex h-5 w-5 cursor-default items-center justify-center max-md:h-6 max-md:w-6"
	data-context-gauge-trigger
	onclick={gaugeTriggerClick}
	onkeydown={gaugeTriggerKeydown}
	onpointerdown={gaugeTriggerPointerDown}
	onpointerenter={gaugeTriggerEnter}
	onpointerleave={gaugeTriggerLeave}
	role="button"
	tabindex="0"
>
	<!-- a phone gets the larger dial: the trigger is a touch target there -->
	<ContextGaugeDial
		level={gauge.colorLevel}
		percent={gauge.contextPercent}
		size={deviceStore.isMobile ? 'md' : 'sm'}
	/>
</div>
