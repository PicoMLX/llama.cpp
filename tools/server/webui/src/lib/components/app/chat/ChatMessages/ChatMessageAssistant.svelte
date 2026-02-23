<script lang="ts">
	import {
		ActionIconCopyToClipboard as CopyToClipboardIcon,
		ChatMessageActions,
		ChatMessageStatistics,
		MarkdownContent,
		ModelBadge,
		ModelsSelector
	} from '$lib/components/app';
	import ChatMessageThinkingBlock from './ChatMessageThinkingBlock.svelte';
	import { getMessageEditContext } from '$lib/contexts';
	import { useProcessingState } from '$lib/hooks/use-processing-state.svelte';
	import { isLoading, isChatStreaming } from '$lib/stores/chat.svelte';
	import { autoResizeTextarea, copyToClipboard, isIMEComposing } from '$lib/utils';
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { Check, Wrench, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { INPUT_CLASSES } from '$lib/constants/css-classes';
	import { MessageRole, KeyboardKey } from '$lib/enums';
	import Label from '$lib/components/ui/label/label.svelte';
	import { config } from '$lib/stores/settings.svelte';
	import { isRouterMode } from '$lib/stores/server.svelte';
	import { t } from '$lib/i18n';
	import { modelsStore } from '$lib/stores/models.svelte';
	import { ServerModelStatus } from '$lib/enums';
	import { REASONING_TAGS } from '$lib/constants/agentic';

	interface Props {
		class?: string;
		deletionInfo: {
			totalCount: number;
			userMessages: number;
			assistantMessages: number;
			messageTypes: string[];
		} | null;
		isLastAssistantMessage?: boolean;
		message: DatabaseMessage;
		messageContent: string | undefined;
		onCopy: () => void;
		onConfirmDelete: () => void;
		onContinue?: () => void;
		onDelete: () => void;
		onEdit?: () => void;
		onNavigateToSibling?: (siblingId: string) => void;
		onRegenerate: (modelOverride?: string) => void;
		onShowDeleteDialogChange: (show: boolean) => void;
		showDeleteDialog: boolean;
		siblingInfo?: ChatMessageSiblingInfo | null;
		textareaElement?: HTMLTextAreaElement;
	}

	interface ParsedReasoningContent {
		content: string;
		reasoningContent: string | null;
		hasReasoningMarkers: boolean;
	}

	function parseReasoningContent(content: string | undefined): ParsedReasoningContent {
		if (!content) {
			return {
				content: '',
				reasoningContent: null,
				hasReasoningMarkers: false
			};
		}

		const plainParts: string[] = [];
		const reasoningParts: string[] = [];
		const { START, END } = REASONING_TAGS;
		let cursor = 0;
		let hasReasoningMarkers = false;

		while (cursor < content.length) {
			const startIndex = content.indexOf(START, cursor);

			if (startIndex === -1) {
				plainParts.push(content.slice(cursor));
				break;
			}

			hasReasoningMarkers = true;
			plainParts.push(content.slice(cursor, startIndex));

			const reasoningStart = startIndex + START.length;
			const endIndex = content.indexOf(END, reasoningStart);

			if (endIndex === -1) {
				reasoningParts.push(content.slice(reasoningStart));
				cursor = content.length;
				break;
			}

			reasoningParts.push(content.slice(reasoningStart, endIndex));
			cursor = endIndex + END.length;
		}

		return {
			content: plainParts.join(''),
			reasoningContent: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
			hasReasoningMarkers
		};
	}

	let {
		class: className = '',
		deletionInfo,
		isLastAssistantMessage = false,
		message,
		messageContent,
		onConfirmDelete,
		onContinue,
		onCopy,
		onDelete,
		onEdit,
		onNavigateToSibling,
		onRegenerate,
		onShowDeleteDialogChange,
		showDeleteDialog,
		siblingInfo = null,
		textareaElement = $bindable()
	}: Props = $props();

	// Get edit context
	const editCtx = getMessageEditContext();

	// Local state for assistant-specific editing
	let shouldBranchAfterEdit = $state(false);

	function handleEditKeydown(event: KeyboardEvent) {
		if (event.key === KeyboardKey.ENTER && !event.shiftKey && !isIMEComposing(event)) {
			event.preventDefault();
			editCtx.save();
		} else if (event.key === KeyboardKey.ESCAPE) {
			event.preventDefault();
			editCtx.cancel();
		}
	}

	const parsedMessageContent = $derived.by(() => parseReasoningContent(messageContent));
	const visibleMessageContent = $derived(parsedMessageContent.content);
	const thinkingContent = $derived(parsedMessageContent.reasoningContent);
	const hasReasoningMarkers = $derived(parsedMessageContent.hasReasoningMarkers);
	const processingState = useProcessingState();

	let currentConfig = $derived(config());
	let isRouter = $derived(isRouterMode());
	let showRawOutput = $state(false);
	let statsContainerEl: HTMLDivElement | undefined = $state();

	// Parse tool calls from the serialized JSON string stored in the database message
	let toolCalls = $derived.by((): ApiChatCompletionToolCall[] | null => {
		if (!message.toolCalls) return null;
		try {
			const parsed = JSON.parse(message.toolCalls);
			return Array.isArray(parsed) ? parsed : null;
		} catch {
			return null;
		}
	});

	// Fallback: if toolCalls JSON parsing fails, show the raw string
	let fallbackToolCalls = $derived.by((): string | null => {
		if (!message.toolCalls) return null;
		if (toolCalls && toolCalls.length > 0) return null;
		return message.toolCalls;
	});

	function getScrollParent(el: HTMLElement): HTMLElement | null {
		let parent = el.parentElement;
		while (parent) {
			const style = getComputedStyle(parent);
			if (/(auto|scroll)/.test(style.overflowY)) {
				return parent;
			}
			parent = parent.parentElement;
		}
		return null;
	}

	async function handleStatsViewChange() {
		const el = statsContainerEl;
		if (!el) {
			return;
		}

		const scrollParent = getScrollParent(el);
		if (!scrollParent) {
			return;
		}

		const yBefore = el.getBoundingClientRect().top;

		await tick();

		const delta = el.getBoundingClientRect().top - yBefore;
		if (delta !== 0) {
			scrollParent.scrollTop += delta;
		}

		// Correct any drift after browser paint
		requestAnimationFrame(() => {
			const drift = el.getBoundingClientRect().top - yBefore;

			if (Math.abs(drift) > 1) {
				scrollParent.scrollTop += drift;
			}
		});
	}

	let displayedModel = $derived(message.model ?? null);

	let isCurrentlyLoading = $derived(isLoading());
	let isStreaming = $derived(isChatStreaming());
	let hasNoContent = $derived(!visibleMessageContent?.trim());
	let isActivelyProcessing = $derived(isCurrentlyLoading || isStreaming);

	let showProcessingInfoTop = $derived(
		message?.role === MessageRole.ASSISTANT &&
			isActivelyProcessing &&
			hasNoContent &&
			isLastAssistantMessage
	);

	let showProcessingInfoBottom = $derived(
		message?.role === MessageRole.ASSISTANT &&
			isActivelyProcessing &&
			!hasNoContent &&
			isLastAssistantMessage
	);

	function handleCopyModel() {
		void copyToClipboard(displayedModel ?? '');
	}

	$effect(() => {
		if (editCtx.isEditing && textareaElement) {
			autoResizeTextarea(textareaElement);
		}
	});

	$effect(() => {
		if (showProcessingInfoTop || showProcessingInfoBottom) {
			processingState.startMonitoring();
		}
	});

	function formatToolCallBadge(toolCall: ApiChatCompletionToolCall, index: number) {
		const callNumber = index + 1;
		const functionName = toolCall.function?.name?.trim();
		const label = functionName || `Call #${callNumber}`;

		const payload: Record<string, unknown> = {};

		const id = toolCall.id?.trim();
		if (id) {
			payload.id = id;
		}

		const type = toolCall.type?.trim();
		if (type) {
			payload.type = type;
		}

		if (toolCall.function) {
			const fnPayload: Record<string, unknown> = {};

			const name = toolCall.function.name?.trim();
			if (name) {
				fnPayload.name = name;
			}

			const rawArguments = toolCall.function.arguments?.trim();
			if (rawArguments) {
				try {
					fnPayload.arguments = JSON.parse(rawArguments);
				} catch {
					fnPayload.arguments = rawArguments;
				}
			}

			if (Object.keys(fnPayload).length > 0) {
				payload.function = fnPayload;
			}
		}

		const formattedPayload = JSON.stringify(payload, null, 2);

		return {
			label,
			tooltip: formattedPayload,
			copyValue: formattedPayload
		};
	}

	function handleCopyToolCall(payload: string) {
		void copyToClipboard(payload, t('chat.message.tool_calls.copied'));
	}
</script>

<div
	class="text-md group w-full leading-7.5 {className}"
	role="group"
	aria-label={t('chat.message.assistant.aria')}
>
	{#if !editCtx.isEditing && thinkingContent}
		<ChatMessageThinkingBlock
			reasoningContent={thinkingContent}
			isStreaming={!message.timestamp}
			hasRegularContent={!!visibleMessageContent?.trim()}
		/>
	{/if}

	{#if showProcessingInfoTop}
		<div class="mt-6 w-full max-w-[48rem]" in:fade>
			<div class="processing-container">
				<span class="processing-text">
					{processingState.getPromptProgressText() ??
						processingState.getProcessingMessage() ??
						'Processing...'}
				</span>
			</div>
		</div>
	{/if}

	{#if editCtx.isEditing}
		<div class="w-full">
			<textarea
				bind:this={textareaElement}
				value={editCtx.editedContent}
				class="min-h-[50vh] w-full resize-y rounded-2xl px-3 py-2 text-sm {INPUT_CLASSES}"
				onkeydown={handleEditKeydown}
				oninput={(e) => {
					autoResizeTextarea(e.currentTarget);
					editCtx.setContent(e.currentTarget.value);
				}}
				placeholder={t('chat.message.assistant.placeholder')}
			></textarea>

			<div class="mt-2 flex items-center justify-between">
				<div class="flex items-center space-x-2">
					<Checkbox
						id="branch-after-edit"
						bind:checked={shouldBranchAfterEdit}
						onCheckedChange={(checked) => (shouldBranchAfterEdit = checked === true)}
					/>
					<Label for="branch-after-edit" class="cursor-pointer text-sm text-muted-foreground">
						{t('chat.message.assistant.branch_after_edit')}
					</Label>
				</div>
				<div class="flex gap-2">
					<Button class="h-8 px-3" onclick={editCtx.cancel} size="sm" variant="outline">
						<X class="mr-1 h-3 w-3" />
						{t('chat.message.assistant.cancel')}
					</Button>

					<Button
						class="h-8 px-3"
						onclick={editCtx.save}
						disabled={!editCtx.editedContent?.trim()}
						size="sm"
					>
						<Check class="mr-1 h-3 w-3" />
						{t('chat.message.assistant.save')}
					</Button>
				</div>
			</div>
		</div>
	{:else if message.role === MessageRole.ASSISTANT}
		{#if showRawOutput}
			<pre class="raw-output">{messageContent || ''}</pre>
		{:else}
			<MarkdownContent content={visibleMessageContent || ''} attachments={message.extra} />
		{/if}
	{:else}
		<div class="text-sm whitespace-pre-wrap">
			{messageContent}
		</div>
	{/if}

	{#if showProcessingInfoBottom}
		<div class="mt-4 w-full max-w-[48rem]" in:fade>
			<div class="processing-container">
				<span class="processing-text">
					{processingState.getPromptProgressText() ??
						processingState.getProcessingMessage() ??
						'Processing...'}
				</span>
			</div>
		</div>
	{/if}

	<div class="info my-6 grid gap-4 tabular-nums">
		{#if displayedModel}
			<div
				bind:this={statsContainerEl}
				class="inline-flex flex-wrap items-start gap-2 text-xs text-muted-foreground"
			>
				{#if isRouter}
					<ModelsSelector
						currentModel={displayedModel}
						disabled={isLoading()}
						onModelChange={async (modelId, modelName) => {
							const status = modelsStore.getModelStatus(modelId);

							if (status !== ServerModelStatus.LOADED) {
								await modelsStore.loadModel(modelId);
							}

							onRegenerate(modelName);
							return true;
						}}
					/>
				{:else}
					<ModelBadge model={displayedModel || undefined} onclick={handleCopyModel} />
				{/if}

				{#if currentConfig.showMessageStats && message.timings && message.timings.predicted_n && message.timings.predicted_ms}
					<ChatMessageStatistics
						promptTokens={message.timings.prompt_n}
						promptMs={message.timings.prompt_ms}
						predictedTokens={message.timings.predicted_n}
						predictedMs={message.timings.predicted_ms}
						onActiveViewChange={handleStatsViewChange}
					/>
				{:else if isLoading() && currentConfig.showMessageStats}
					{@const liveStats = processingState.getLiveProcessingStats()}
					{@const genStats = processingState.getLiveGenerationStats()}
					{@const promptProgress = processingState.processingState?.promptProgress}
					{@const isStillProcessingPrompt =
						promptProgress && promptProgress.processed < promptProgress.total}

					{#if liveStats || genStats}
						<ChatMessageStatistics
							isLive={true}
							isProcessingPrompt={!!isStillProcessingPrompt}
							promptTokens={liveStats?.tokensProcessed}
							promptMs={liveStats?.timeMs}
							predictedTokens={genStats?.tokensGenerated}
							predictedMs={genStats?.timeMs}
						/>
					{/if}
				{/if}
			</div>
		{/if}

		{#if config().showToolCalls}
			{#if (toolCalls && toolCalls.length > 0) || fallbackToolCalls}
				<span class="inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span class="inline-flex items-center gap-1">
						<Wrench class="h-3.5 w-3.5" />

						<span>{t('chat.message.tool_calls.label')}</span>
					</span>

					{#if toolCalls && toolCalls.length > 0}
						{#each toolCalls as toolCall, index (toolCall.id ?? `${index}`)}
							{@const badge = formatToolCallBadge(toolCall, index)}
							<button
								type="button"
								class="tool-call-badge inline-flex cursor-pointer items-center gap-1 rounded-sm bg-muted-foreground/15 px-1.5 py-0.75"
								title={badge.tooltip}
								aria-label={t('chat.message.tool_calls.copy', { label: badge.label })}
								onclick={() => handleCopyToolCall(badge.copyValue)}
							>
								{badge.label}
								<CopyToClipboardIcon
									text={badge.copyValue}
									ariaLabel={t('chat.message.tool_calls.copy', { label: badge.label })}
								/>
							</button>
						{/each}
					{:else if fallbackToolCalls}
						<button
							type="button"
							class="tool-call-badge tool-call-badge--fallback inline-flex cursor-pointer items-center gap-1 rounded-sm bg-muted-foreground/15 px-1.5 py-0.75"
							title={fallbackToolCalls}
							aria-label={t('chat.message.tool_calls.copy_payload')}
							onclick={() => handleCopyToolCall(fallbackToolCalls)}
						>
							{fallbackToolCalls}
							<CopyToClipboardIcon
								text={fallbackToolCalls}
								ariaLabel={t('chat.message.tool_calls.copy_payload')}
							/>
						</button>
					{/if}
				</span>
			{/if}
		{/if}
	</div>

	{#if message.timestamp && !editCtx.isEditing}
		<ChatMessageActions
			role={MessageRole.ASSISTANT}
			justify="start"
			actionsPosition="left"
			{siblingInfo}
			{showDeleteDialog}
			{deletionInfo}
			{onCopy}
			{onEdit}
			{onRegenerate}
			onContinue={currentConfig.enableContinueGeneration && !hasReasoningMarkers
				? onContinue
				: undefined}
			{onDelete}
			{onConfirmDelete}
			{onNavigateToSibling}
			{onShowDeleteDialogChange}
			showRawOutputSwitch={currentConfig.showRawOutputSwitch}
			rawOutputEnabled={showRawOutput}
			onRawOutputToggle={(enabled) => (showRawOutput = enabled)}
		/>
	{/if}
</div>

<style>
	.processing-container {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.processing-text {
		background: linear-gradient(
			90deg,
			var(--muted-foreground),
			var(--foreground),
			var(--muted-foreground)
		);
		background-size: 200% 100%;
		background-clip: text;
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: shine 1s linear infinite;
		font-weight: 500;
		font-size: 0.875rem;
	}

	@keyframes shine {
		to {
			background-position: -200% 0;
		}
	}

	.raw-output {
		width: 100%;
		max-width: 48rem;
		margin-top: 1.5rem;
		padding: 1rem 1.25rem;
		border-radius: 1rem;
		background: hsl(var(--muted) / 0.3);
		color: var(--foreground);
		font-family:
			ui-monospace, SFMono-Regular, 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas,
			'Liberation Mono', Menlo, monospace;
		font-size: 0.875rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
