<script lang="ts">
	import ChatFormActionsAdd from '$lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActionAdd/ChatFormActionsAdd.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { setChatFormActionsContext } from '$lib/contexts';

	let { onFiles, onInstructions }: { onFiles: () => void; onInstructions: () => void } = $props();

	setChatFormActionsContext({
		disabled: false,
		hasAudioModality: false,
		hasVideoModality: false,
		hasVisionModality: false,
		onFileUpload: () => onFiles(),
		onSystemPromptClick: () => onInstructions()
	});
</script>

<Tooltip.Provider>
	<ChatFormActionsAdd />
</Tooltip.Provider>
