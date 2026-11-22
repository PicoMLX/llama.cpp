<script lang="ts">
	import ChatForm from '$lib/components/app/chat/ChatForm/ChatForm.svelte';
	import ChatScreenHeader from '$lib/components/app/chat/ChatScreen/ChatScreenHeader.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let { onInstructions }: { onInstructions?: () => void } = $props();
	let form: ChatForm | undefined = $state();
	let value = $state('');

	export function validateModel() {
		return form?.checkModelSelected();
	}

	export function openModelPicker() {
		form?.openModelSelector();
	}

	export function setValue(text: string) {
		value = text;
	}
</script>

<Tooltip.Provider>
	<ChatScreenHeader {onInstructions} />

	<ChatForm bind:this={form} bind:value />
</Tooltip.Provider>
