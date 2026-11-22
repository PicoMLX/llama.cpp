import { chatStore, conversationsStore } from '$lib/stores';
import { untrack } from 'svelte';

export function useConversationProcessing() {
	$effect(() => {
		const conversationId = conversationsStore.activeConversation?.id ?? null;

		untrack(() => chatStore.processing.setActiveConversation(conversationId));
	});

	$effect(() => {
		const conversation = conversationsStore.activeConversation;
		const messages = conversationsStore.activeMessages as DatabaseMessage[];

		if (!conversation || chatStore.isLoading || chatStore.isStreaming()) return;

		if (messages.length === 0) {
			untrack(() => chatStore.processing.setState(conversation.id, null));

			return;
		}

		untrack(() => chatStore.processing.restoreFromMessages(messages, conversation.id));
	});
}
