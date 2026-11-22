<script lang="ts">
	import ChatMessages from '$lib/components/app/chat/ChatMessages/ChatMessages.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { DatabaseMessage } from '$lib/types';

	let { messages }: { messages: DatabaseMessage[] } = $props();
</script>

<Tooltip.Provider>
	<ChatMessages {messages} />
</Tooltip.Provider>
