<script lang="ts">
	import { page } from '$app/state';
	import { ChatScreen, ChatTabs } from '$lib/components/app';
	import { IS_PICO_BUILD, NEW_CHAT_TAB_ID } from '$lib/constants';
	import { settingsStore, tabsStore } from '$lib/stores';

	let { children } = $props();

	// the new-chat screen is the bare `#/` route (no conversation id)
	let showCenteredEmpty = $derived(!page.params.id);

	let showTabs = $derived(
		!IS_PICO_BUILD &&
			Boolean(settingsStore.config.conversationTabs) &&
			(page.params.id || tabsStore.openTabs.some((id) => id !== NEW_CHAT_TAB_ID))
	);

	$effect(() => {
		const id = page.params.id ?? (page.route.id === '/(chat)' ? NEW_CHAT_TAB_ID : undefined);

		if (!IS_PICO_BUILD && id && settingsStore.config.conversationTabs) {
			tabsStore.syncWithRoute(id);
		}
	});
</script>

<!-- the offset is the tab bar's full height (pt-3.25 + h-10), so the chat
     column still fits the viewport and only scrolls when the messages overflow -->
<div class={showTabs ? 'md:[--chat-tabs-height:3.3125rem] md:[--chat-tabs-offset:3.3125rem]' : ''}>
	{#if showTabs}
		<ChatTabs />
	{/if}

	<ChatScreen {showCenteredEmpty} />
</div>

{@render children?.()}
