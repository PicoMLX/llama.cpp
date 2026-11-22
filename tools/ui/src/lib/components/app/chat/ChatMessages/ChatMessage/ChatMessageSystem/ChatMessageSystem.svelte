<script lang="ts">
	import { Check, X } from '@lucide/svelte';
	import { ChatMessageActionIcons, MarkdownContent } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import { Card } from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { INPUT_CLASSES } from '$lib/constants';
	import { IS_PICO_BUILD } from '$lib/constants/app.constants';
	import { getChatMessageEditContext } from '$lib/contexts';
	import { KeyboardKey } from '$lib/enums';
	import { agenticStore, chatStore, settingsStore } from '$lib/stores';
	import { autoResizeTextarea, isIMEComposing } from '$lib/utils';

	interface Props {
		class?: string;
		message: DatabaseMessage;
		textareaElement?: HTMLTextAreaElement;
	}

	let { class: className = '', message, textareaElement = $bindable() }: Props = $props();

	const editCtx = getChatMessageEditContext();
	const originBusy = $derived(
		IS_PICO_BUILD &&
			Boolean(editCtx.conversationId) &&
			(chatStore.isChatLoadingInternal(editCtx.conversationId!) ||
				agenticStore.isRunning(editCtx.conversationId!) ||
				chatStore.activity.isRemote(editCtx.conversationId!))
	);

	function handleEditKeydown(event: KeyboardEvent) {
		if (
			event.key === KeyboardKey.ENTER &&
			!event.shiftKey &&
			!isIMEComposing(event) &&
			(!IS_PICO_BUILD || event.ctrlKey || event.metaKey)
		) {
			if (originBusy) return;

			event.preventDefault();

			editCtx.save();
		} else if (event.key === KeyboardKey.ESCAPE) {
			event.preventDefault();

			editCtx.cancel();
		}
	}

	let isMultiline = $state(false);
	let messageElement: HTMLElement | undefined = $state();
	let isExpanded = $state(false);
	let contentHeight = $state(0);

	const MAX_HEIGHT = 200; // pixels
	const currentConfig = settingsStore.config;

	let showExpandButton = $derived(contentHeight > MAX_HEIGHT);

	$effect(() => {
		if (!messageElement || !message.content.trim()) return;

		if (message.content.includes('\n')) {
			isMultiline = true;
		}

		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const element = entry.target as HTMLElement;
				const estimatedSingleLineHeight = 24;

				isMultiline = element.offsetHeight > estimatedSingleLineHeight * 1.5;
				contentHeight = element.scrollHeight;
			}
		});

		resizeObserver.observe(messageElement);

		return () => {
			resizeObserver.disconnect();
		};
	});
	$effect(() => {
		if (editCtx.isEditing && textareaElement) {
			autoResizeTextarea(textareaElement);
		}
	});

	function toggleExpand() {
		isExpanded = !isExpanded;
	}
</script>

{#if IS_PICO_BUILD}
	<Dialog.Root
		onOpenChange={(open) => {
			if (!open && editCtx.isEditing) editCtx.cancel();
		}}
		open={editCtx.isEditing}
	>
		<Dialog.Content class="w-[calc(100vw-2rem)] max-w-xl">
			<Dialog.Header>
				<Dialog.Title>Chat instructions</Dialog.Title>

				<Dialog.Description
					>Applies to this chat. Leave blank to remove its instructions.</Dialog.Description
				>
			</Dialog.Header>

			<textarea
				bind:this={textareaElement}
				aria-label="Chat instructions"
				class="min-h-40 w-full resize-y rounded-xl border border-input bg-background p-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
				oninput={(event) => editCtx.setContent(event.currentTarget.value)}
				onkeydown={handleEditKeydown}
				placeholder="How should the assistant respond in this chat?"
				value={editCtx.editedContent}
			></textarea>

			<Dialog.Footer>
				<Button class="min-h-[44px]" onclick={editCtx.cancel} variant="ghost">Cancel</Button>

				<Button class="min-h-[44px]" disabled={originBusy} onclick={editCtx.save}
					>Save instructions</Button
				>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<div
		aria-label="System message with actions"
		class="group flex flex-col items-end gap-3 md:gap-2 {className}"
		role="group"
	>
		{#if editCtx.isEditing}
			<div class="w-full max-w-[80%]">
				<textarea
					bind:this={textareaElement}
					class="min-h-[60px] w-full resize-none rounded-2xl px-3 py-2 text-sm {INPUT_CLASSES}"
					oninput={(e) => {
						autoResizeTextarea(e.currentTarget);
						editCtx.setContent(e.currentTarget.value);
					}}
					onkeydown={handleEditKeydown}
					placeholder="Edit system message..."
					style="max-height: var(--max-message-height);"
					value={editCtx.editedContent}
				></textarea>

				<div class="mt-2 flex justify-end gap-2">
					<Button class="h-8 px-3" onclick={editCtx.cancel} size="sm" variant="outline">
						<X class="mr-1 h-3 w-3" />

						Cancel
					</Button>

					<Button
						class="h-8 px-3"
						disabled={!editCtx.editedContent.trim()}
						onclick={editCtx.save}
						size="sm"
					>
						<Check class="mr-1 h-3 w-3" />

						Save
					</Button>
				</div>
			</div>
		{:else}
			{#if message.content.trim()}
				<div class="relative max-w-[80%]">
					<button
						class="group/expand block w-full text-left {!isExpanded && showExpandButton
							? 'cursor-pointer'
							: 'cursor-auto'}"
						onclick={showExpandButton && !isExpanded ? toggleExpand : undefined}
						type="button"
					>
						<Card
							class="overflow-y-auto rounded-[1.125rem] !border-2 !border-dashed !border-border/50 bg-muted px-3.75 py-1.5 data-[multiline]:py-2.5"
							data-multiline={isMultiline ? '' : undefined}
							style="border: 2px dashed hsl(var(--border)); max-height: var(--max-message-height); overflow-wrap: anywhere; word-break: break-word;"
						>
							<div
								class="relative transition-all duration-300 {isExpanded
									? 'cursor-text select-text'
									: 'select-none'}"
								style={!isExpanded && showExpandButton
									? `max-height: ${MAX_HEIGHT}px;`
									: 'max-height: none;'}
							>
								{#if currentConfig.renderUserContentAsMarkdown}
									<div bind:this={messageElement} class={isExpanded ? 'cursor-text' : ''}>
										<MarkdownContent class="markdown-system-content" content={message.content} />
									</div>
								{:else}
									<span
										bind:this={messageElement}
										class="text-md whitespace-pre-wrap {isExpanded ? 'cursor-text' : ''}"
									>
										{message.content}
									</span>
								{/if}

								{#if !isExpanded && showExpandButton}
									<div
										class="pointer-events-none absolute right-0 bottom-0 left-0 h-48 bg-gradient-to-t from-muted to-transparent"
									></div>

									<div
										class="pointer-events-none absolute right-0 bottom-4 left-0 flex justify-center opacity-0 transition-opacity group-hover/expand:opacity-100"
									>
										<Button
											class="rounded-full px-4 py-1.5 text-xs shadow-md"
											size="sm"
											variant="outline"
										>
											Show full system message
										</Button>
									</div>
								{/if}
							</div>

							{#if isExpanded && showExpandButton}
								<div class="mb-2 flex justify-center">
									<Button
										class="rounded-full px-4 py-1.5 text-xs"
										onclick={(e) => {
											e.stopPropagation();
											toggleExpand();
										}}
										size="sm"
										variant="outline"
									>
										Collapse System Message
									</Button>
								</div>
							{/if}
						</Card>
					</button>
				</div>
			{/if}

			{#if message.timestamp}
				<div class="max-w-[80%]">
					<ChatMessageActionIcons actionsPosition="right" justify="end" />
				</div>
			{/if}
		{/if}
	</div>
{/if}
