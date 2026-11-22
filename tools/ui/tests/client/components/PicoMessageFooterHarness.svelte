<script lang="ts">
	import ChatMessage from '$lib/components/app/chat/ChatMessages/ChatMessage/ChatMessage.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { ChatMessageActions, ChatMessageSiblingInfo, DatabaseMessage } from '$lib/types';

	let {
		chatActions,
		message,
		nextAssistantMessage = null,
		siblingInfo = null
	}: {
		message: DatabaseMessage;
		chatActions: ChatMessageActions;
		nextAssistantMessage?: DatabaseMessage | null;
		siblingInfo?: ChatMessageSiblingInfo | null;
	} = $props();
</script>

<Tooltip.Provider>
	<ChatMessage {chatActions} {message} {nextAssistantMessage} {siblingInfo} />
</Tooltip.Provider>
