<script lang="ts">
	import { X, AlertTriangle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { ChatForm, DialogConfirmation } from '$lib/components/app';
	import { getMessageEditContext } from '$lib/contexts';
	import { KeyboardKey } from '$lib/enums';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { processFilesToChatUploaded } from '$lib/utils/browser-only';
	import { t } from '$lib/i18n';

	const editCtx = getMessageEditContext();

	let inputAreaRef: ChatForm | undefined = $state(undefined);
	let saveWithoutRegenerate = $state(false);
	let showDiscardDialog = $state(false);

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

		if (saveWithoutRegenerate && editCtx.showSaveOnlyOption) {
			editCtx.saveOnly();
		} else {
			editCtx.save();
		}

		saveWithoutRegenerate = false;
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
		chatStore.setEditModeActive(handleFilesAdd);

		return () => {
			chatStore.clearEditMode();
		};
	});
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="relative w-full max-w-[80%]">
	<ChatForm
		bind:this={inputAreaRef}
		value={editCtx.editedContent}
		attachments={editCtx.editedExtras}
		uploadedFiles={editCtx.editedUploadedFiles}
		placeholder="Edit your message..."
		onValueChange={editCtx.setContent}
		onAttachmentRemove={handleAttachmentRemove}
		onUploadedFileRemove={handleUploadedFileRemove}
		onFilesAdd={handleFilesAdd}
		onSubmit={handleSubmit}
	/>
</div>

<div class="mt-2 flex w-full max-w-[80%] items-center justify-between">
	{#if editCtx.showSaveOnlyOption}
		<div class="flex items-center gap-2">
			<Switch id="save-only-switch" bind:checked={saveWithoutRegenerate} class="scale-75" />

			<label for="save-only-switch" class="cursor-pointer text-xs text-muted-foreground">
				{t('chat.message.edit.update_without_resend')}
			</label>
		</div>
	{:else}
		<div></div>
	{/if}

	<Button class="h-7 px-3 text-xs" onclick={attemptCancel} size="sm" variant="ghost">
		<X class="mr-1 h-3 w-3" />

		{t('chat.message.edit.cancel')}
	</Button>
</div>

<DialogConfirmation
	bind:open={showDiscardDialog}
	title={t('chat.message.edit.discard.title')}
	description={t('chat.message.edit.discard.description')}
	confirmText={t('chat.message.edit.discard.confirm')}
	cancelText={t('chat.message.edit.discard.cancel')}
	variant="destructive"
	icon={AlertTriangle}
	onConfirm={editCtx.cancel}
	onCancel={() => (showDiscardDialog = false)}
/>
