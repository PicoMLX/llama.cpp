<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import Label from '$lib/components/ui/label/label.svelte';
	import { HEADERS, ICON_CLASS_DEFAULT, ROUTES, SETTINGS_KEYS } from '$lib/constants';
	import { t } from '$lib/i18n';
	import { serverStore, settingsStore } from '$lib/stores';
	import { onMount, tick } from 'svelte';

	let { class: className = '' }: { class?: string } = $props();
	let key = $state('');
	let connecting = $state(false);
	let error = $state('');
	let input = $state<HTMLInputElement | null>(null);

	onMount(() => {
		key = String(settingsStore.config.apiKey ?? '');
		input?.focus();
	});

	async function connect(event: SubmitEvent) {
		event.preventDefault();

		if (connecting || !key.trim()) return;

		connecting = true;
		error = '';
		settingsStore.updateConfig(SETTINGS_KEYS.API_KEY, key.trim());

		try {
			const response = await fetch(`${base}/props`, {
				headers: {
					'Content-Type': 'application/json',
					[HEADERS.AUTHORIZATION]: `${HEADERS.BEARER}${key.trim()}`
				}
			});

			if (response.ok) {
				await serverStore.fetch();
				await goto(ROUTES.START, { invalidateAll: true });
			} else {
				error = t(
					response.status === 401 || response.status === 403
						? 'pico.access.invalid'
						: 'pico.access.cannot_connect'
				);
			}
		} catch {
			error = t('pico.access.cannot_connect');
		} finally {
			connecting = false;

			if (error) {
				await tick();
				input?.focus();
			}
		}
	}
</script>

<div class="flex h-full items-center justify-center {className}">
	<form class="w-full max-w-md space-y-6 px-4" onsubmit={connect}>
		<div class="space-y-2">
			<h1 class="text-2xl font-semibold tracking-tight">{t('pico.access.title')}</h1>

			<p class="text-sm text-muted-foreground" id="pico-access-description">
				{t('pico.access.message')}
			</p>
		</div>

		<div class="space-y-2">
			<Label for="pico-access-key">{t('pico.access.label')}</Label>

			<Input
				bind:ref={input}
				bind:value={key}
				aria-describedby={`pico-access-description${error ? ' pico-access-error' : ''}`}
				aria-invalid={!!error}
				autocomplete="current-password"
				disabled={connecting}
				id="pico-access-key"
				type="password"
			/>

			{#if error}
				<p class="text-sm text-destructive" id="pico-access-error" role="alert">{error}</p>
			{/if}
		</div>

		<Button class="w-full" disabled={connecting || !key.trim()} type="submit">
			{#if connecting}
				<RefreshCw aria-hidden="true" class="{ICON_CLASS_DEFAULT} animate-spin" />
				{t('server.error.retry.connecting')}
			{:else}
				{t('pico.access.connect')}
			{/if}
		</Button>
	</form>
</div>
