<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { ATTACHMENT_TOOLTIP_TEXT, ICON_CLASS_DEFAULT } from '$lib/constants';
	import { IS_PICO_BUILD } from '$lib/constants/app.constants';

	interface Props {
		disabled?: boolean;
		onclick?: (e: MouseEvent) => void;
	}

	let { disabled = false, onclick }: Props = $props();
	const tooltip = IS_PICO_BUILD ? 'Add files and tools' : ATTACHMENT_TOOLTIP_TEXT;
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				class="file-upload-button bg-background h-9 w-9 rounded-full p-0 shadow-sm md:h-8 md:w-8 dark:bg-muted-foreground/15 {IS_PICO_BUILD
					? 'min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0'
					: ''}"
				{disabled}
				{onclick}
				type="button"
				variant="ghost"
			>
				<span class="sr-only">{tooltip}</span>

				<Plus class={ICON_CLASS_DEFAULT} />
			</Button>
		{/snippet}
	</Tooltip.Trigger>

	<Tooltip.Content>
		<p>{tooltip}</p>
	</Tooltip.Content>
</Tooltip.Root>
