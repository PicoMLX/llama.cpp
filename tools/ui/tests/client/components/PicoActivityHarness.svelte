<script lang="ts">
	import ChatMessageAgenticContent from '$lib/components/app/chat/ChatMessages/ChatMessageAgenticContent.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { DatabaseMessage } from '$lib/types';

	let {
		isStreaming = false,
		message,
		toolMessages = []
	}: {
		message: DatabaseMessage;
		toolMessages?: DatabaseMessage[];
		isStreaming?: boolean;
	} = $props();
</script>

<Tooltip.Provider>
	<ChatMessageAgenticContent isLastAssistantMessage {isStreaming} {message} {toolMessages} />
</Tooltip.Provider>
