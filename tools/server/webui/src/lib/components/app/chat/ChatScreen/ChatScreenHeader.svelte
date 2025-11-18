<script lang="ts">
	import { Settings } from '@lucide/svelte';
	import { ChatSettingsDialog } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import { useSidebar } from '$lib/components/ui/sidebar';
	import { SquarePen } from '@lucide/svelte';

	let settingsOpen = $state(false);
	const sidebar = useSidebar();

	function toggleSettings() {
		settingsOpen = true;
	}
</script>

<header
	class={`md:background-transparent pointer-events-none fixed top-0 right-0 left-0 z-50 flex items-center justify-between bg-background/40 p-4 backdrop-blur-xl ${
		!sidebar.isMobile && sidebar.state === 'expanded'
			? 'md:left-[var(--sidebar-width)]'
			: 'md:left-0'
	}`}
>

	<div class="pointer-events-auto ml-12 flex items-center space-x-2">
		{#if (!sidebar.isMobile && sidebar.state === 'collapsed') || (sidebar.isMobile && !sidebar.openMobile)}
			<Button variant="ghost" size="sm" href="?new_chat=true#/"
				><SquarePen class="h-4 w-4" /></Button
			>
		{/if}
	</div>

	<div class="pointer-events-auto flex items-center space-x-2">
		<Button variant="ghost" size="sm" onclick={toggleSettings}>
			<Settings class="h-4 w-4" />
		</Button>
	</div>
</header>

<ChatSettingsDialog open={settingsOpen} onOpenChange={(open) => (settingsOpen = open)} />
