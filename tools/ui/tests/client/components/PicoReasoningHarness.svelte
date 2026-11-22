<script lang="ts">
	import { useReasoningMenu } from '$lib/hooks/use-reasoning-menu.svelte';

	const reasoning = useReasoningMenu();
</script>

<output aria-label="Reasoning levels"
	>{reasoning.levels.map((level) => level.value).join(',')}</output
>
