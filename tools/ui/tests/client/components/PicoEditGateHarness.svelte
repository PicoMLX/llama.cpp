<script lang="ts">
	import ChatMessageEditForm from '$lib/components/app/chat/ChatMessages/ChatMessageEditForm.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { setChatMessageEditContext } from '$lib/contexts';
	import { MessageRole } from '$lib/enums';
	import type { ChatUploadedFile } from '$lib/types';

	let {
		files = [],
		onSave,
		role = MessageRole.USER
	}: { files?: ChatUploadedFile[]; role?: MessageRole; onSave: () => void } = $props();
	let content = $state('Changed message');
	setChatMessageEditContext({
		cancel: () => {},
		conversationId: 'edit-gate-origin',
		get editedContent() {
			return content;
		},
		editedExtras: [],
		get editedUploadedFiles() {
			return files;
		},
		isEditing: true,
		get messageRole() {
			return role;
		},
		originalContent: 'Original message',
		originalExtras: [],
		save: () => onSave(),
		saveOnly: () => {},
		setContent: (value) => {
			content = value;
		},
		setExtras: () => {},
		setShouldBranchAfterEdit: () => {},
		setUploadedFiles: (value) => {
			files = value;
		},
		shouldBranchAfterEdit: false,
		showBranchAfterEditOption: false,
		showSaveOnlyOption: true,
		startEdit: () => {}
	});
</script>

<Tooltip.Provider><ChatMessageEditForm /></Tooltip.Provider>
