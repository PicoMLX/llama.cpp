<script lang="ts">
	import { ChatScreen, DialogModelNotAvailable } from '$lib/components/app';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { conversationsStore, isConversationsInitialized } from '$lib/stores/conversations.svelte';
	import { modelsStore, modelOptions } from '$lib/stores/models.svelte';
	import { isRouterMode } from '$lib/stores/server.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { serverName } from '$lib/stores/server.svelte';

	let qParam = $derived(page.url.searchParams.get('q'));
	let modelParam = $derived(page.url.searchParams.get('model'));
	let newChatParam = $derived(page.url.searchParams.get('new_chat'));

	// Dialog state for model not available error
	let showModelNotAvailable = $state(false);
	let requestedModelName = $state('');
	let availableModelNames = $derived(modelOptions().map((m) => m.model));

	/**
	 * Clear URL params after message is sent to prevent re-sending on refresh
	 */
	function clearUrlParams() {
		const url = new URL(page.url);

		url.searchParams.delete('q');
		url.searchParams.delete('model');
		url.searchParams.delete('new_chat');

		replaceState(url.toString(), {});
	}

	async function handleUrlParams(isCancelled?: () => boolean) {
		// Fast path: new chat only needs URL cleanup; avoid async model fetch work that can race with
		// the user's first submit and clobber a just-created chat navigation.
		if (qParam === null && modelParam === null && newChatParam === 'true') {
			if (!isCancelled?.()) {
				clearUrlParams();
			}
			return;
		}

		await modelsStore.fetch();
		if (isCancelled?.()) return;

		if (modelParam) {
			const model = modelsStore.findModelByName(modelParam);

			if (model) {
				try {
					await modelsStore.selectModelById(model.id);
					if (isCancelled?.()) return;
				} catch (error) {
					console.error('Failed to select model:', error);
					requestedModelName = modelParam;
					showModelNotAvailable = true;

					return;
				}
			} else {
				requestedModelName = modelParam;
				showModelNotAvailable = true;

				return;
			}
		}

		// Handle ?q= parameter - create new conversation and send message
		if (qParam !== null) {
			await conversationsStore.createConversation();
			if (isCancelled?.()) return;
			await chatStore.sendMessage(qParam);
			if (isCancelled?.()) return;
			clearUrlParams();
		} else if (modelParam || newChatParam === 'true') {
			clearUrlParams();
		}
	}

	onMount(() => {
		let cancelled = false;

		(async () => {
			if (!isConversationsInitialized()) {
				await conversationsStore.initialize();
				if (cancelled) return;
			}

			conversationsStore.clearActiveConversation();
			chatStore.clearUIState();

			if (
				isRouterMode() &&
				modelsStore.selectedModelName &&
				!modelsStore.isModelLoaded(modelsStore.selectedModelName)
			) {
				modelsStore.clearSelection();

				const first = modelOptions().find((m) => modelsStore.loadedModelIds.includes(m.model));
				if (first) {
					await modelsStore.selectModelById(first.id);
				}
			}

			// Handle URL params only if we have ?q= or ?model= or ?new_chat=true
			if (qParam !== null || modelParam !== null || newChatParam === 'true') {
				await handleUrlParams(() => cancelled);
			}
		})().catch((error) => {
			if (!cancelled) {
				console.error('Failed to handle landing page initialization:', error);
			}
		});

		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:head>
	<title>{serverName()} - AI Chat Interface</title>
</svelte:head>

<ChatScreen showCenteredEmpty />

<DialogModelNotAvailable
	bind:open={showModelNotAvailable}
	modelName={requestedModelName}
	availableModels={availableModelNames}
/>
