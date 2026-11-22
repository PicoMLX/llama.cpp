<script lang="ts">
	import ChatScreen from '$lib/components/app/chat/ChatScreen/ChatScreen.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
</script>

<Tooltip.Provider>
	<ChatScreen showCenteredEmpty />
</Tooltip.Provider>
