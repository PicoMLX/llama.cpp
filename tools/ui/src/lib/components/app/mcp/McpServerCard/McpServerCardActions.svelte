<script lang="ts">
	import { Ellipsis, Pencil, RefreshCw, Trash2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { IS_PICO_BUILD } from '$lib/constants';

	interface Props {
		isHealthChecking: boolean;
		onEdit: () => void;
		onRefresh: () => void;
		onDelete: () => void;
	}

	let { isHealthChecking, onDelete, onEdit, onRefresh }: Props = $props();
</script>

<div class="flex shrink-0 items-center gap-1">
	{#if IS_PICO_BUILD}
		<Button disabled={isHealthChecking} onclick={onRefresh} size="sm" variant="outline">
			{isHealthChecking ? 'Connecting...' : 'Reconnect'}
		</Button>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				aria-label="Connection actions"
				class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md hover:bg-muted"
			>
				<Ellipsis class="size-4" />
			</DropdownMenu.Trigger>

			<DropdownMenu.Content align="end">
				<DropdownMenu.Item onSelect={onEdit}>Edit connection</DropdownMenu.Item>

				<DropdownMenu.Item onSelect={onDelete} variant="destructive"
					>Remove connection</DropdownMenu.Item
				>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{:else}
		<Button aria-label="Edit" class="h-7 w-7" onclick={onEdit} size="icon" variant="ghost">
			<Pencil class="h-3.5 w-3.5" />
		</Button>

		<Button
			aria-label="Refresh"
			class="h-7 w-7"
			disabled={isHealthChecking}
			onclick={onRefresh}
			size="icon"
			variant="ghost"
		>
			<RefreshCw class="h-3.5 w-3.5" />
		</Button>

		<Button
			aria-label="Delete"
			class="hover:text-destructive-foreground h-7 w-7 text-destructive hover:bg-destructive/10"
			onclick={onDelete}
			size="icon"
			variant="ghost"
		>
			<Trash2 class="h-3.5 w-3.5" />
		</Button>
	{/if}
</div>
