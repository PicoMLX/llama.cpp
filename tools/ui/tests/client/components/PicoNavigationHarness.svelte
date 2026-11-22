<script lang="ts">
	import SidebarNavigationActions from '$lib/components/app/navigation/SidebarNavigation/SidebarNavigationActions.svelte';
	import SidebarNavigationConversationItem from '$lib/components/app/navigation/SidebarNavigation/SidebarNavigationConversationItem.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { SidebarAction } from '$lib/enums';

	interface Props {
		conversation?: DatabaseConversation;
		footer?: boolean;
		onAction?: (action: SidebarAction) => void;
		onSelect?: (id: string) => void;
	}

	let { conversation, footer = false, onAction, onSelect }: Props = $props();
</script>

<Tooltip.Provider>
	{#if conversation}
		<SidebarNavigationConversationItem {conversation} {onSelect} />
	{:else}
		<SidebarNavigationActions class="" {footer} {onAction} />
	{/if}
</Tooltip.Provider>
