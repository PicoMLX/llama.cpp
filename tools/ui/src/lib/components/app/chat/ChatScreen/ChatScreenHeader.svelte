<script lang="ts">
	import ContextGaugeDetails from '../ChatForm/ChatFormContextGauge/ContextGaugeDetails.svelte';
	import { Info, MessageSquare, MoreHorizontal } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { SYSTEM_MESSAGE_PLACEHOLDER } from '$lib/constants';
	import { MessageRole } from '$lib/enums';
	import { useContextGauge } from '$lib/hooks/use-context-gauge.svelte';
	import { useConversationProcessing } from '$lib/hooks/use-conversation-processing.svelte';
	import { RouterService } from '$lib/services/router.service';
	import { chatStore, conversationsStore } from '$lib/stores';

	let { onInstructions }: { onInstructions?: () => void } = $props();

	useConversationProcessing();
	const context = useContextGauge();
	let detailsOpen = $state(false);
	let suppressMenuFocus = false;
	let pendingInstructionEdit: { conversationId: string; messageId: string } | null = null;
	const conversation = $derived(conversationsStore.activeConversation);
	const instructionHistory = $derived(
		conversationsStore.activeMessages.filter(
			(message) =>
				message.role === MessageRole.SYSTEM &&
				message.content.trim() &&
				message.content !== SYSTEM_MESSAGE_PLACEHOLDER
		)
	);
	const contextWarning = $derived(
		conversation && context.contextPercent !== null && context.contextPercent >= 80
	);
	const criticalContext = $derived((context.contextPercent ?? 0) >= 95);
	const canSummarize = $derived(chatStore.canCompact(conversationsStore.activeMessages));

	$effect(() => {
		context.startMonitoring();
	});

	function editInstructions() {
		suppressMenuFocus = true;
		onInstructions?.();
	}

	function openDetails() {
		setTimeout(() => (detailsOpen = true), 0);
	}

	function summarize() {
		detailsOpen = false;
		void chatStore.compactConversation();
	}

	function editInstruction(messageId: string) {
		if (!conversation) return;

		pendingInstructionEdit = { conversationId: conversation.id, messageId };
		detailsOpen = false;
	}
</script>

<header
	aria-label="Chat controls"
	class="sticky top-0 z-[5] -mx-4 flex flex-col bg-background/95 px-4 backdrop-blur-sm"
>
	<div class="flex h-14 min-w-0 items-center justify-end gap-3 pl-11 md:pl-0">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						aria-label="Chat options"
						class="size-9 min-h-11 min-w-11 shrink-0 rounded-full p-0 max-md:translate-y-2"
						variant="ghost"
					>
						<MoreHorizontal class="size-5" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>

			<DropdownMenu.Content
				align="end"
				onCloseAutoFocus={(event) => {
					if (suppressMenuFocus) {
						suppressMenuFocus = false;
						event.preventDefault();
					}
				}}
			>
				<DropdownMenu.Item class="gap-2" disabled={chatStore.isLoading} onSelect={editInstructions}>
					<MessageSquare class="size-4" />
					Instructions
				</DropdownMenu.Item>

				<DropdownMenu.Item class="gap-2" disabled={!conversation} onSelect={openDetails}>
					<Info class="size-4" />
					Conversation details
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	{#if contextWarning}
		<div
			class="flex items-center justify-between gap-3 pb-2 text-xs text-muted-foreground"
			role="status"
		>
			<span
				>{criticalContext ? 'This chat is close to its limit.' : 'This chat is getting long.'}</span
			>

			<Button
				class="h-auto shrink-0 px-2 py-1 text-xs"
				onclick={() => (detailsOpen = true)}
				variant="ghost"
			>
				View details
			</Button>
		</div>
	{/if}
</header>

<Dialog.Root bind:open={detailsOpen}>
	<Dialog.Content
		class="w-[calc(100vw-2rem)] max-w-lg"
		onCloseAutoFocus={(event) => {
			if (!pendingInstructionEdit) return;

			event.preventDefault();
			const target = pendingInstructionEdit;

			pendingInstructionEdit = null;

			if (conversation?.id === target.conversationId) {
				chatStore.pendingEditMessageId = target.messageId;
			}
		}}
	>
		<Dialog.Header>
			<Dialog.Title>Conversation details</Dialog.Title>

			<Dialog.Description>{conversation?.name ?? 'New chat'}</Dialog.Description>
		</Dialog.Header>

		{#if conversation?.forkedFromConversationId}
			<p class="text-sm text-muted-foreground">
				Branched from another chat.
				<a
					class="text-foreground underline underline-offset-2"
					href={RouterService.chat(conversation.forkedFromConversationId)}
					onclick={() => (detailsOpen = false)}>View original chat</a
				>
			</p>
		{/if}

		<div>
			<h3 class="text-sm font-medium">Context usage</h3>

			{#if context.contextTotal !== null}
				<p class="mt-1 text-sm text-muted-foreground">
					{context.contextUsed.toLocaleString()} of {context.contextTotal.toLocaleString()} tokens ({context.contextPercent ??
						0}%)
				</p>
			{:else}
				<p class="mt-1 text-sm text-muted-foreground">
					Context size is unavailable for this model.
				</p>
			{/if}

			{#if context.hasAnyUsage}
				<ContextGaugeDetails
					averageTokensPerSecond={context.averageTokensPerSecond}
					cumulativeCacheTotal={context.cumulativeCacheTotal}
					cumulativeOutput={context.cumulativeOutput}
					cumulativeRead={context.cumulativeRead}
					currentCache={context.currentCache}
					currentFresh={context.currentFresh}
					currentOutput={context.currentOutput}
					currentRead={context.currentRead}
					kvTotal={context.kvTotal}
					transientDetails={context.transientDetails}
				/>
			{/if}
		</div>

		{#if instructionHistory.length > 0}
			<details class="border-t border-border/30 pt-4">
				<summary class="cursor-pointer text-sm font-medium">Advanced</summary>

				<section aria-label="Instruction history" class="mt-4 space-y-3">
					<h3 class="text-sm font-medium">Instruction history</h3>

					<ol class="space-y-4">
						{#each instructionHistory as instruction, index (instruction.id)}
							<li class="rounded-lg border border-border/30 p-3">
								<p class="mb-2 text-xs text-muted-foreground">Instruction {index + 1}</p>

								<p class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">
									{instruction.content}
								</p>

								<Button
									aria-label={`Edit instruction ${index + 1}`}
									class="mt-2 min-h-11"
									disabled={chatStore.isLoading}
									onclick={() => editInstruction(instruction.id)}
									variant="outline">Edit</Button
								>
							</li>
						{/each}
					</ol>
				</section>
			</details>
		{/if}

		{#if canSummarize}
			<div class="border-t border-border/30 pt-4">
				<p class="mb-3 text-sm text-muted-foreground">
					Summarize earlier messages to make room for more conversation.
				</p>

				<Button disabled={chatStore.isLoading} onclick={summarize} variant="outline"
					>Summarize chat</Button
				>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
