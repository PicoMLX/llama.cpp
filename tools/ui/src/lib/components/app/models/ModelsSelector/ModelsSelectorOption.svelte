<script lang="ts">
	import ModelLoadHighlight from '../ModelLoadHighlight.svelte';
	import { Check, Loader2 } from '@lucide/svelte';
	import {
		ModelAvatar,
		ModelCapabilities,
		ModelId,
		ModelLoadControl,
		ModelRowActions
	} from '$lib/components/app';
	import { IS_PICO_BUILD, SETTINGS_KEYS } from '$lib/constants';
	import { ModelCapability, ServerModelStatus } from '$lib/enums';
	import { modelsStore, settingsStore } from '$lib/stores';
	import type { ModelOption } from '$lib/types/models';
	import { modelLoadFraction, modelLoadProgressText } from '$lib/utils';

	interface Props {
		option: ModelOption;
		isSelected: boolean;
		isHighlighted: boolean;
		isFav: boolean;
		hideOrgName?: boolean;
		showVariant?: boolean;
		onSelect: (modelId: string) => void;
		onMouseEnter: () => void;
		onKeyDown: (e: KeyboardEvent) => void;
	}

	let {
		hideOrgName = false,
		isFav,
		isHighlighted,
		isSelected,
		onKeyDown,
		onMouseEnter,
		onSelect,
		option,
		showVariant = false
	}: Props = $props();

	let serverStatus = $derived(modelsStore.getModelStatus(option.model));
	let isOperationInProgress = $derived(modelsStore.status.isOperationInProgress(option.model));
	let isFailed = $derived(serverStatus === ServerModelStatus.FAILED);
	let isSleeping = $derived(serverStatus === ServerModelStatus.SLEEPING);
	let isLoaded = $derived(modelsStore.isModelRunning(option.model));
	let isLoading = $derived(serverStatus === ServerModelStatus.LOADING || isOperationInProgress);

	let loadProgress = $derived(isLoading ? modelsStore.status.getLoadProgress(option.model) : null);
	let loadPercent = $derived(Math.round(modelLoadFraction(loadProgress) * 100));
	let loadTitle = $derived(modelLoadProgressText(loadProgress));
	let modalities = $derived(option.modalities);
	let showCapabilities = $derived(
		settingsStore.config[SETTINGS_KEYS.SHOW_MODEL_CAPABILITIES_IN_SELECTOR] ?? false
	);
	let capabilityLabel = $derived(
		[
			...(modalities?.vision ? ['Images'] : []),
			...(modalities?.audio ? ['Audio'] : []),
			...(option.capabilities.includes(ModelCapability.REASONING) ? ['Thinking'] : []),
			...(option.capabilities.includes(ModelCapability.TOOL_USE) ? ['Tools'] : [])
		].join(' / ')
	);
</script>

<div
	aria-selected={IS_PICO_BUILD ? isSelected : isSelected || isHighlighted}
	class={[
		'group relative flex w-full items-center gap-2 rounded-sm p-2 text-left text-sm transition focus:outline-none',
		'cursor-pointer',
		// skip layout and paint for rows scrolled out of the long lists
		'[content-visibility:auto] [contain-intrinsic-size:auto_2.25rem] max-md:[contain-intrinsic-size:auto_3rem]',
		// a phone gives the row and its tappable area room to breathe
		'max-md:gap-2.5 max-md:px-2.5 max-md:py-2.5',
		isSelected && !isHighlighted && 'bg-accent/50',
		isHighlighted && 'bg-accent',
		(isSelected || isHighlighted) && 'text-accent-foreground',
		'hover:bg-accent',
		'focus:bg-accent',
		IS_PICO_BUILD || isLoaded ? 'text-popover-foreground' : 'text-muted-foreground'
	]}
	data-model-id={option.id}
	onclick={() => onSelect(option.id)}
	onkeydown={onKeyDown}
	onmouseenter={onMouseEnter}
	role="option"
	tabindex="0"
	title={loadTitle}
>
	<ModelAvatar {option} showQuantBadge={!IS_PICO_BUILD} size="size-5 max-md:size-7" />

	<div class={IS_PICO_BUILD ? 'min-w-0 flex-1' : 'contents'}>
		<ModelId
			aliases={option.aliases}
			class="min-w-0 flex-1"
			draftSidecars={IS_PICO_BUILD ? undefined : option.draftSidecars}
			hideCapabilities
			hideModalities
			hideOrgName={IS_PICO_BUILD ? true : hideOrgName}
			hideQuantization={IS_PICO_BUILD ? true : undefined}
			hideTags={IS_PICO_BUILD ? true : undefined}
			{modalities}
			modelId={option.model}
			readableName={IS_PICO_BUILD}
			tags={option.tags}
			title={option.model}
		/>

		{#if IS_PICO_BUILD && showVariant}
			<p class="mt-0.5 break-all font-mono text-xs text-muted-foreground">{option.model}</p>
		{/if}

		{#if IS_PICO_BUILD && capabilityLabel}
			<p class="mt-0.5 text-xs text-muted-foreground">{capabilityLabel}</p>
		{/if}
	</div>

	{#if !IS_PICO_BUILD && showCapabilities}
		<ModelCapabilities {option} />
	{/if}

	{#if IS_PICO_BUILD}
		{#if isLoading}
			<Loader2 aria-label="Loading model" class="size-4 shrink-0 animate-spin" />
		{:else if isFailed}
			<span class="shrink-0 text-xs text-destructive">Load failed</span>
		{:else if isSelected}
			<Check aria-label="Selected" class="size-4 shrink-0" />
		{/if}
	{:else}
		<div class="flex shrink-0 items-center gap-1 max-md:gap-2.5">
			<ModelRowActions {isFav} {option} />

			<ModelLoadControl {isFailed} {isLoaded} {isLoading} {isSleeping} {option} />
		</div>
	{/if}

	{#if isLoading}
		<ModelLoadHighlight percent={loadPercent} />
	{/if}
</div>
