<script lang="ts">
	import ModelsSelector from '../../models/ModelsSelector/ModelsSelector.svelte';
	import ChatMessageActionIconsBranchingControls from './ChatMessageActions/ChatMessageActionIcons/ChatMessageActionIconsBranchingControls.svelte';
	import { Copy, Edit, Ellipsis, RefreshCw } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { getChatMessageActionsContext, getChatMessageEditContext } from '$lib/contexts';
	import { MessageRole, ServerModelStatus } from '$lib/enums';
	import { modelsStore } from '$lib/stores';
	import type { Snippet } from 'svelte';

	interface Props {
		justify: 'start' | 'end';
		onRegenerate?: (modelOverride?: string) => void;
		onContinue?: () => void;
		onFork: () => void;
		showRawOutputSwitch: boolean;
		rawOutputEnabled: boolean;
		onRawOutputToggle?: (enabled: boolean) => void;
		responseModel?: string | null;
		allowModelRetry?: boolean;
		details?: Snippet;
		isLoading?: boolean;
	}

	let {
		allowModelRetry = false,
		details,
		isLoading = false,
		justify,
		onContinue,
		onFork,
		onRawOutputToggle,
		onRegenerate,
		rawOutputEnabled,
		responseModel,
		showRawOutputSwitch
	}: Props = $props();

	const actions = getChatMessageActionsContext();
	const edit = getChatMessageEditContext();
	const isUser = $derived(edit.messageRole === MessageRole.USER && !onRegenerate);
	const buttonClass =
		'flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40 md:size-8';
	let showModelRetry = $state(false);
</script>

<div
	class="pico-message-actions mt-2 flex flex-wrap items-center gap-x-2 {justify === 'end'
		? 'justify-end'
		: 'justify-start'}"
>
	{#if actions.siblingInfo && actions.siblingInfo.totalSiblings > 1}
		<ChatMessageActionIconsBranchingControls />
	{/if}

	<div class="flex items-center">
		{#if isUser}
			<button
				aria-label="Edit"
				class={buttonClass}
				onclick={edit.startEdit}
				title="Edit"
				type="button"
			>
				<Edit class="size-4" />
			</button>
		{/if}

		<button aria-label="Copy" class={buttonClass} onclick={actions.copy} title="Copy" type="button">
			<Copy class="size-4" />
		</button>

		{#if !isUser && onRegenerate}
			<button
				aria-label="Retry"
				class={buttonClass}
				disabled={isLoading}
				onclick={() => !isLoading && onRegenerate?.()}
				title="Retry"
				type="button"
			>
				<RefreshCw class="size-4" />
			</button>
		{/if}

		<DropdownMenu.Root>
			<DropdownMenu.Trigger aria-label="More message actions" class={buttonClass} title="More">
				<Ellipsis class="size-4" />
			</DropdownMenu.Trigger>

			<DropdownMenu.Content align={justify === 'end' ? 'end' : 'start'} class="min-w-52">
				{#if !isUser}
					<DropdownMenu.Item onSelect={edit.startEdit}>Edit response</DropdownMenu.Item>
				{/if}

				{#if onRegenerate && allowModelRetry}
					<DropdownMenu.Item
						disabled={isLoading}
						onSelect={() => !isLoading && (showModelRetry = true)}
					>
						Retry with another model...
					</DropdownMenu.Item>
				{/if}

				{#if onContinue}
					<DropdownMenu.Item onSelect={onContinue}>Continue response</DropdownMenu.Item>
				{/if}

				{#if actions.forkConversation}
					<DropdownMenu.Item onSelect={onFork}>Branch into new chat</DropdownMenu.Item>
				{/if}

				{#if showRawOutputSwitch}
					<DropdownMenu.CheckboxItem checked={rawOutputEnabled} onCheckedChange={onRawOutputToggle}>
						Show raw output
					</DropdownMenu.CheckboxItem>
				{/if}

				<DropdownMenu.Separator />

				<DropdownMenu.Item onSelect={actions.requestDelete} variant="destructive">
					Delete message
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	{@render details?.()}
</div>

{#if allowModelRetry && onRegenerate}
	<Dialog.Root bind:open={showModelRetry}>
		<Dialog.Content class="max-w-md">
			<Dialog.Header>
				<Dialog.Title>Retry with another model</Dialog.Title>

				<Dialog.Description>Choose a model to generate a new response version.</Dialog.Description>
			</Dialog.Header>

			<ModelsSelector
				currentModel={responseModel}
				disabled={isLoading}
				onModelChange={async (modelId, modelName) => {
					if (isLoading) return false;

					if (modelsStore.getModelStatus(modelId) !== ServerModelStatus.LOADED) {
						await modelsStore.status.load(modelId);
					}

					if (isLoading) return false;

					showModelRetry = false;
					onRegenerate?.(modelName);

					return true;
				}}
			/>
		</Dialog.Content>
	</Dialog.Root>
{/if}

<style>
	@media (width <= 768px), (pointer: coarse) {
		.pico-message-actions :global(button) {
			min-height: 44px;
			min-width: 44px;
		}
	}
</style>
