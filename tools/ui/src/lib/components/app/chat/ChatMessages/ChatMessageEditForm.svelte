<script lang="ts">
	import { AlertTriangle, X } from '@lucide/svelte';
	import { ChatForm, DialogConfirmation } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { IS_PICO_BUILD } from '$lib/constants/app.constants';
	import { getChatMessageEditContext } from '$lib/contexts';
	import { KeyboardKey, MessageRole } from '$lib/enums';
	import { agenticStore, chatStore, conversationsStore } from '$lib/stores';
	import { processFilesToChatUploaded } from '$lib/utils/browser-only';

	const editCtx = getChatMessageEditContext();

	let saveWithoutRegenerate = $state(false);
	let showDiscardDialog = $state(false);
	let branchAfterEdit = $state(false);
	let formRef: ChatForm | undefined = $state();
	const originId = $derived(
		editCtx.conversationId ?? conversationsStore.activeConversation?.id ?? ''
	);
	const originBusy = $derived(
		IS_PICO_BUILD &&
			(chatStore.isChatLoadingInternal(originId) ||
				agenticStore.isRunning(originId) ||
				chatStore.activity.isRemote(originId))
	);

	let isUserMessage = $derived(editCtx.messageRole === MessageRole.USER);
	let isAssistantMessage = $derived(editCtx.messageRole === MessageRole.ASSISTANT);

	let hasUnsavedChanges = $derived.by(() => {
		if (editCtx.editedContent !== editCtx.originalContent) return true;

		if (editCtx.editedUploadedFiles.length > 0) return true;

		const extrasChanged =
			editCtx.editedExtras.length !== editCtx.originalExtras.length ||
			editCtx.editedExtras.some((extra, i) => extra !== editCtx.originalExtras[i]);

		if (extrasChanged) return true;

		return false;
	});

	let hasAttachments = $derived(
		(editCtx.editedExtras && editCtx.editedExtras.length > 0) ||
			(editCtx.editedUploadedFiles && editCtx.editedUploadedFiles.length > 0)
	);

	let canSubmit = $derived(editCtx.editedContent.trim().length > 0 || hasAttachments);
	const canSave = $derived(
		canSubmit &&
			(!IS_PICO_BUILD || (!originBusy && Boolean(formRef?.isReadyToSubmit(isUserMessage))))
	);

	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.key === KeyboardKey.ESCAPE) {
			event.preventDefault();
			attemptCancel();
		}
	}

	function attemptCancel() {
		if (hasUnsavedChanges) {
			showDiscardDialog = true;
		} else {
			editCtx.cancel();
		}
	}

	function handleSubmit() {
		if (!canSubmit) return;

		if (IS_PICO_BUILD && (originBusy || !formRef?.isReadyToSubmit(false))) return;

		if (IS_PICO_BUILD && isUserMessage && !formRef?.checkModelSelected()) return;

		if (IS_PICO_BUILD) {
			if (isAssistantMessage) editCtx.setShouldBranchAfterEdit?.(false);

			editCtx.save();
		} else if (isUserMessage && saveWithoutRegenerate && editCtx.showSaveOnlyOption) {
			editCtx.saveOnly();
		} else {
			if (isAssistantMessage && editCtx.setShouldBranchAfterEdit) {
				editCtx.setShouldBranchAfterEdit(branchAfterEdit);
			}

			editCtx.save();
		}

		saveWithoutRegenerate = false;
		branchAfterEdit = false;
	}

	function handleAttachmentRemove(index: number) {
		const newExtras = [...editCtx.editedExtras];

		newExtras.splice(index, 1);
		editCtx.setExtras(newExtras);
	}

	function handleUploadedFileRemove(fileId: string) {
		const newFiles = editCtx.editedUploadedFiles.filter((f) => f.id !== fileId);

		editCtx.setUploadedFiles(newFiles);
	}

	async function handleFilesAdd(files: File[]) {
		const processed = await processFilesToChatUploaded(files);

		editCtx.setUploadedFiles([...editCtx.editedUploadedFiles, ...processed]);
	}

	$effect(() => {
		return chatStore.setEditModeActive(handleFilesAdd, editCtx.conversationId ?? null);
	});
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class={IS_PICO_BUILD ? 'relative w-full' : 'relative w-full max-w-[80%]'}>
	<ChatForm
		bind:this={formRef}
		bind:uploadedFiles={
			() => editCtx.editedUploadedFiles, (files) => editCtx.setUploadedFiles(files)
		}
		attachments={editCtx.editedExtras}
		disabled={originBusy}
		hideSubmitButton={IS_PICO_BUILD}
		onAttachmentRemove={handleAttachmentRemove}
		onFilesAdd={handleFilesAdd}
		onSubmit={handleSubmit}
		onUploadedFileRemove={handleUploadedFileRemove}
		onValueChange={editCtx.setContent}
		placeholder="Edit your message..."
		showAddButton={editCtx.messageRole === MessageRole.USER}
		showModelSelector={!IS_PICO_BUILD && editCtx.messageRole === MessageRole.USER}
		value={editCtx.editedContent}
	/>
</div>

{#if IS_PICO_BUILD}
	<div class="mt-3 flex w-full flex-wrap items-center justify-end gap-2">
		{#if isAssistantMessage}
			<p class="mr-auto text-xs text-muted-foreground">Edits this saved response.</p>
		{/if}

		<Button class="min-h-[44px] px-4" onclick={attemptCancel} variant="ghost">Cancel</Button>

		<Button class="min-h-[44px] px-4" disabled={!canSave} onclick={handleSubmit}>
			{isUserMessage ? 'Send changes' : 'Save response'}
		</Button>
	</div>
{:else}
	<div class="mt-2 flex w-full max-w-[80%] items-center justify-between">
		{#if isUserMessage && editCtx.showSaveOnlyOption}
			<div class="flex items-center gap-2">
				<Switch bind:checked={saveWithoutRegenerate} class="scale-75" id="save-only-switch" />

				<label class="cursor-pointer text-xs text-muted-foreground" for="save-only-switch">
					Update without re-sending
				</label>
			</div>
		{:else if isAssistantMessage}
			<div class="flex items-center gap-2">
				<Switch bind:checked={branchAfterEdit} class="scale-75" id="branch-after-edit" />

				<label class="cursor-pointer text-xs text-muted-foreground" for="branch-after-edit">
					Branch conversation after edit
				</label>
			</div>
		{:else}
			<div></div>
		{/if}

		<Button class="h-7 px-3 text-xs" onclick={attemptCancel} size="sm" variant="ghost">
			<X class="mr-1 h-3 w-3" />

			Cancel
		</Button>
	</div>
{/if}

<DialogConfirmation
	bind:open={showDiscardDialog}
	cancelText="Keep editing"
	confirmText="Discard"
	description="You have unsaved changes. Are you sure you want to discard them?"
	icon={AlertTriangle}
	onCancel={() => (showDiscardDialog = false)}
	onConfirm={editCtx.cancel}
	title="Discard changes?"
	variant="destructive"
/>
