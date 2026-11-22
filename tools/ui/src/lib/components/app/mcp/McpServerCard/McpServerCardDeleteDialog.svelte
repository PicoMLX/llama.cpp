<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { IS_PICO_BUILD } from '$lib/constants';

	interface Props {
		open: boolean;
		displayName: string;
		onOpenChange: (open: boolean) => void;
		onConfirm: () => void;
	}

	let { displayName, onConfirm, onOpenChange, open = $bindable() }: Props = $props();
</script>

<AlertDialog.Root bind:open {onOpenChange}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{IS_PICO_BUILD ? 'Remove connection' : 'Delete Server'}</AlertDialog.Title>

			<AlertDialog.Description>
				{#if IS_PICO_BUILD}
					Remove <strong>{displayName}</strong> and its saved connection settings?
				{:else}
					Are you sure you want to delete <strong>{displayName}</strong>? This action cannot be
					undone.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>

			<AlertDialog.Action
				class="text-destructive-foreground bg-destructive hover:bg-destructive/90"
				onclick={onConfirm}
			>
				{IS_PICO_BUILD ? 'Remove' : 'Delete'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
