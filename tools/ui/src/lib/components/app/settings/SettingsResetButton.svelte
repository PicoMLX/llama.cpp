<script lang="ts">
	import { RotateCcw } from '@lucide/svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { settingsStore } from '$lib/stores';

	interface Props {
		onReset?: () => void;
		keys?: string[];
		sectionTitle?: string;
		hasDraftChanges?: boolean;
	}

	let { hasDraftChanges = false, keys, onReset, sectionTitle }: Props = $props();

	let showResetDialog = $state(false);

	function handleResetClick() {
		showResetDialog = true;
	}

	function handleConfirmReset() {
		if (keys) {
			settingsStore.resetSettingsForKeys(keys);
		} else {
			settingsStore.forceSyncWithServerDefaults();
		}

		onReset?.();

		showResetDialog = false;
	}
</script>

{#if hasDraftChanges || (keys ? settingsStore.hasCustomSettingsForKeys(keys) : settingsStore.hasCustomSettings)}
	<Button onclick={handleResetClick} variant="outline">
		<RotateCcw class="h-3 w-3" />

		{sectionTitle ? `Reset ${sectionTitle}` : 'Reset to default'}
	</Button>
{/if}

<AlertDialog.Root bind:open={showResetDialog}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title
				>{sectionTitle
					? `Reset ${sectionTitle} settings?`
					: 'Reset Settings to Default'}</AlertDialog.Title
			>

			<AlertDialog.Description>
				{#if keys}
					Only these preferences will return to their defaults. Your connections, access key and
					other sections will stay saved.
				{:else}
					Are you sure you want to reset all settings to their default values? This will reset all
					parameters to the values provided by the server's /props endpoint and remove all your
					custom configurations.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>

			<AlertDialog.Action onclick={handleConfirmReset}>Reset to Default</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
