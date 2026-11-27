<script lang="ts">
	import { Wrench } from '@lucide/svelte';
	import { CollapsibleContentBlock } from '$lib/components/app';
	import { IS_PICO_BUILD } from '$lib/constants/app.constants';
	import { ColorMode } from '$lib/enums';
	import { toolsStore } from '$lib/stores';
	import type {
		ResponsesMcpApprovalRequestItem,
		ResponsesMcpCallItem,
		ResponsesMcpItem
	} from '$lib/types';
	import { getMcpIconUrl, isMcpCallRunning, mcpCallErrorText } from '$lib/utils';
	import { mode } from 'mode-watcher';

	interface Props {
		items: ResponsesMcpItem[];
		isStreaming: boolean;
		onToggle?: () => void;
		open: boolean;
	}

	let { isStreaming, items, onToggle, open }: Props = $props();

	const calls = $derived(
		items.filter((item): item is ResponsesMcpCallItem => item.type === 'mcp_call')
	);
	const requests = $derived(
		items.filter(
			(item): item is ResponsesMcpApprovalRequestItem => item.type === 'mcp_approval_request'
		)
	);
	const decisions = $derived(
		new Map(
			items.flatMap((item) =>
				item.type === 'mcp_approval_response' ? [[item.approval_request_id, item.approve]] : []
			)
		)
	);
	const running = $derived(isStreaming ? calls.find(isMcpCallRunning) : undefined);
	const waiting = $derived(
		isStreaming ? requests.find((request) => !decisions.has(request.id)) : undefined
	);
	// a request left unanswered is denied with the next message
	const declined = $derived(
		requests.filter(
			(request) =>
				decisions.get(request.id) === false || (!isStreaming && !decisions.has(request.id))
		)
	);
	const approved = $derived(requests.filter((request) => decisions.get(request.id) === true));
	const failedCount = $derived(
		calls.filter((call) => call.status === 'failed' || call.error != null).length
	);

	function toolTitle(name: string): string {
		return toolsStore.getPicoTool(name)?.title ?? name;
	}

	function titles(list: { name: string }[]): string {
		return [...new Set(list.map((item) => toolTitle(item.name)))].join(', ');
	}

	function formatArguments(value: string): string {
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			return value;
		}
	}

	const title = $derived.by(() => {
		if (running) return `Using ${toolTitle(running.name)}...`;

		if (waiting) return `Waiting for approval to use ${toolTitle(waiting.name)}`;

		const parts: string[] = [];

		if (calls.length > 0) parts.push(`Used ${titles(calls)}`);

		if (declined.length > 0) parts.push(`Declined ${titles(declined)}`);

		if (parts.length === 0 && approved.length > 0) parts.push(`Approved ${titles(approved)}`);

		return parts.join('; ');
	});
	const iconUrl = $derived.by(() => {
		const first = running ?? waiting ?? calls[0] ?? requests[0];

		return first
			? getMcpIconUrl(toolsStore.getPicoTool(first.name)?.icons, mode.current === ColorMode.DARK)
			: null;
	});
	const subtitle = $derived(
		!running && failedCount > 0 ? `${failedCount} failed` : isStreaming ? '' : undefined
	);
</script>

<CollapsibleContentBlock
	class="my-2"
	collapsible={!running && !waiting && calls.length > 0}
	compact={IS_PICO_BUILD}
	icon={iconUrl ? undefined : Wrench}
	iconClass="h-3.5 w-3.5"
	{iconUrl}
	{onToggle}
	{open}
	shimmerTitle={Boolean(running || waiting)}
	{subtitle}
	{title}
>
	<div class="space-y-3 text-[13px] text-muted-foreground">
		{#each calls as call (call.id)}
			{@const error = mcpCallErrorText(call.error)}
			<div class="space-y-1">
				<div class="font-medium text-foreground">{toolTitle(call.name)}</div>

				{#if call.arguments && call.arguments !== '{}'}
					<pre class="pico-tool-text">{formatArguments(call.arguments)}</pre>
				{/if}

				{#if error}
					<p class="text-destructive">{error}</p>
				{:else if call.output}
					<pre class="pico-tool-text">{call.output}</pre>
				{/if}
			</div>
		{/each}
	</div>
</CollapsibleContentBlock>

<style>
	.pico-tool-text {
		max-height: 16rem;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 12px;
	}
</style>
