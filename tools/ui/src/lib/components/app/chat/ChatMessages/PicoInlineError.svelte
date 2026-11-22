<script lang="ts">
	import { AlertCircle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { ErrorDialogType } from '$lib/enums';
	import type { ErrorDialogState } from '$lib/types';

	interface Props {
		error: ErrorDialogState;
		disabled?: boolean;
		onRetry?: () => Promise<void> | void;
		onSummarize?: () => Promise<void> | void;
		onDismiss: () => void;
	}
	let { disabled = false, error, onDismiss, onRetry, onSummarize }: Props = $props();
	let pending = $state(false);
	const tooLong = $derived(
		Boolean(error.contextInfo && error.contextInfo.n_prompt_tokens > error.contextInfo.n_ctx)
	);
	const title = $derived(
		tooLong
			? 'This chat is too long for the selected model.'
			: error.operation === 'compaction'
				? 'Pico could not summarize this chat.'
				: error.type === ErrorDialogType.TIMEOUT
					? 'The response timed out.'
					: 'Pico could not finish this response.'
	);

	async function run(action: (() => Promise<void> | void) | undefined) {
		if (pending || disabled || !action) return;

		pending = true;
		try {
			await action();
		} finally {
			pending = false;
		}
	}
</script>

<div
	class="mx-auto mt-4 w-full max-w-3xl rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
	role="alert"
>
	<p class="flex items-start gap-2 font-medium">
		<AlertCircle class="mt-0.5 size-4 shrink-0" />{title}
	</p>

	<p class="mt-2 text-muted-foreground">
		{tooLong
			? onSummarize
				? 'Summarize earlier messages or start a new chat.'
				: 'Shorten your message or start a new chat.'
			: 'Check the connection, then try again.'}
	</p>

	<div class="mt-3 flex flex-wrap gap-2">
		{#if tooLong && onSummarize}
			<Button disabled={disabled || pending} onclick={() => run(onSummarize)} size="sm"
				>Summarize earlier messages</Button
			>
		{:else if onRetry}
			<Button disabled={disabled || pending} onclick={() => run(onRetry)} size="sm"
				>Try again</Button
			>
		{/if}

		<Button onclick={onDismiss} size="sm" variant="ghost">Dismiss</Button>
	</div>

	<details class="mt-3 text-xs text-muted-foreground">
		<summary class="cursor-pointer">Technical details</summary>

		<p class="mt-2 whitespace-pre-wrap break-words">{error.message}</p>

		{#if error.contextInfo}<p class="mt-2">
				Input: {error.contextInfo.n_prompt_tokens.toLocaleString()} tokens; model capacity: {error.contextInfo.n_ctx.toLocaleString()}
				tokens.
			</p>{/if}
	</details>
</div>
