<script lang="ts">
	import ChatMessage from '$lib/components/app/chat/ChatMessages/ChatMessage/ChatMessage.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { ChatMessageActions, ChatMessageSiblingInfo, DatabaseMessage } from '$lib/types';

	let {
		chatActions,
		isLastAssistantMessage = false,
		message,
		nextAssistantMessage = null,
		siblingInfo = null,
		toolMessages = []
	}: {
		message: DatabaseMessage;
		chatActions: ChatMessageActions;
		isLastAssistantMessage?: boolean;
		nextAssistantMessage?: DatabaseMessage | null;
		siblingInfo?: ChatMessageSiblingInfo | null;
		toolMessages?: DatabaseMessage[];
	} = $props();
</script>

<Tooltip.Provider>
	<ChatMessage
		{chatActions}
		{isLastAssistantMessage}
		{message}
		{nextAssistantMessage}
		{siblingInfo}
		{toolMessages}
	/>
</Tooltip.Provider>
