<script lang="ts">
	import { RefreshCw, Server } from '@lucide/svelte';
	import { ServerStatus } from '$lib/components/app';
	import { IS_PICO_BUILD } from '$lib/constants';
	import { t } from '$lib/i18n';
	import { fade } from 'svelte/transition';

	interface Props {
		class?: string;
		message?: string;
	}

	let { class: className = '', message }: Props = $props();
</script>

{#if IS_PICO_BUILD}
	<div class="flex h-full items-center justify-center gap-2 {className}" role="status">
		<RefreshCw aria-hidden="true" class="h-4 w-4 animate-spin text-muted-foreground" />

		<p class="text-sm text-muted-foreground">{message ?? t('pico.setup.connecting')}</p>
	</div>
{:else}
	<div class="flex h-full items-center justify-center {className}">
		<div class="text-center">
			<div in:fade={{ duration: 300 }} class="mb-4">
				<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
					<Server class="h-8 w-8 animate-pulse text-muted-foreground" />
				</div>

				<h2 class="mb-2 text-xl font-semibold">{t('server.loading.title')}</h2>

				<p class="text-sm text-muted-foreground">
					{message ?? t('server.loading.message')}
				</p>
			</div>

			<div class="mt-4">
				<ServerStatus class="justify-center" />
			</div>
		</div>
	</div>
{/if}
