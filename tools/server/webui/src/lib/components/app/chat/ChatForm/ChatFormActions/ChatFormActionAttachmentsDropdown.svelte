<script lang="ts">
	import { page } from '$app/state';
	import { Plus, MessageSquare } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { FILE_TYPE_ICONS } from '$lib/constants/icons';
	import { TOOLTIP_DELAY_DURATION } from '$lib/constants/tooltip-config';
	import { t } from '$lib/i18n';

	interface Props {
		class?: string;
		disabled?: boolean;
		hasAudioModality?: boolean;
		hasVisionModality?: boolean;
		onFileUpload?: () => void;
		onSystemPromptClick?: () => void;
	}

	let {
		class: className = '',
		disabled = false,
		hasAudioModality = false,
		hasVisionModality = false,
		onFileUpload,
		onSystemPromptClick
	}: Props = $props();

	let isNewChat = $derived(!page.params.id);

	let systemMessageTooltip = $derived(
		isNewChat
			? t('chat.form.attachments.system_prompt_tooltip_new')
			: t('chat.form.attachments.system_prompt_tooltip_inject')
	);

	let dropdownOpen = $state(false);

	const fileUploadTooltipText = t('chat.form.attachments.tooltip_default');
</script>

<div class="flex items-center gap-1 {className}">
	<DropdownMenu.Root bind:open={dropdownOpen}>
		<DropdownMenu.Trigger name={t('chat.form.attachments.trigger_label')} {disabled}>
			<Tooltip.Root>
				<Tooltip.Trigger class="w-full">
					<Button
						class="file-upload-button h-8 w-8 rounded-full p-0"
						{disabled}
						variant="secondary"
						type="button"
					>
						<span class="sr-only">{fileUploadTooltipText}</span>

						<Plus class="h-4 w-4" />
					</Button>
				</Tooltip.Trigger>

				<Tooltip.Content>
					<p>{fileUploadTooltipText}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</DropdownMenu.Trigger>

		<DropdownMenu.Content align="start" class="w-48">
			{#if hasVisionModality}
				<DropdownMenu.Item
					class="images-button flex cursor-pointer items-center gap-2"
					onclick={() => onFileUpload?.()}
				>
					<FILE_TYPE_ICONS.image class="h-4 w-4" />

					<span>{t('chat.form.attachments.images')}</span>
				</DropdownMenu.Item>
			{:else}
				<Tooltip.Root delayDuration={TOOLTIP_DELAY_DURATION}>
					<Tooltip.Trigger class="w-full">
						<DropdownMenu.Item
							class="images-button flex cursor-pointer items-center gap-2"
							disabled
						>
							<FILE_TYPE_ICONS.image class="h-4 w-4" />

							<span>{t('chat.form.attachments.images')}</span>
						</DropdownMenu.Item>
					</Tooltip.Trigger>

					<Tooltip.Content side="right">
						<p>{t('chat.form.attachments.images_requires_vision')}</p>
					</Tooltip.Content>
				</Tooltip.Root>
			{/if}

			{#if hasAudioModality}
				<DropdownMenu.Item
					class="audio-button flex cursor-pointer items-center gap-2"
					onclick={() => onFileUpload?.()}
				>
					<FILE_TYPE_ICONS.audio class="h-4 w-4" />

					<span>{t('chat.form.attachments.audio')}</span>
				</DropdownMenu.Item>
			{:else}
				<Tooltip.Root delayDuration={TOOLTIP_DELAY_DURATION}>
					<Tooltip.Trigger class="w-full">
						<DropdownMenu.Item class="audio-button flex cursor-pointer items-center gap-2" disabled>
							<FILE_TYPE_ICONS.audio class="h-4 w-4" />

							<span>{t('chat.form.attachments.audio')}</span>
						</DropdownMenu.Item>
					</Tooltip.Trigger>

					<Tooltip.Content side="right">
						<p>{t('chat.form.attachments.audio_requires_model')}</p>
					</Tooltip.Content>
				</Tooltip.Root>
			{/if}

			<DropdownMenu.Item
				class="flex cursor-pointer items-center gap-2"
				onclick={() => onFileUpload?.()}
			>
				<FILE_TYPE_ICONS.text class="h-4 w-4" />

				<span>{t('chat.form.attachments.text')}</span>
			</DropdownMenu.Item>

			{#if hasVisionModality}
				<DropdownMenu.Item
					class="flex cursor-pointer items-center gap-2"
					onclick={() => onFileUpload?.()}
				>
					<FILE_TYPE_ICONS.pdf class="h-4 w-4" />

					<span>{t('chat.form.attachments.pdf')}</span>
				</DropdownMenu.Item>
			{:else}
				<Tooltip.Root delayDuration={TOOLTIP_DELAY_DURATION}>
					<Tooltip.Trigger class="w-full">
						<DropdownMenu.Item
							class="flex cursor-pointer items-center gap-2"
							onclick={() => onFileUpload?.()}
						>
							<FILE_TYPE_ICONS.pdf class="h-4 w-4" />

							<span>{t('chat.form.attachments.pdf')}</span>
						</DropdownMenu.Item>
					</Tooltip.Trigger>

					<Tooltip.Content side="right">
						<p>{t('chat.form.attachments.pdf_text_warning')}</p>
					</Tooltip.Content>
				</Tooltip.Root>
			{/if}

			<Tooltip.Root delayDuration={TOOLTIP_DELAY_DURATION}>
				<Tooltip.Trigger class="w-full">
					<DropdownMenu.Item
						class="flex cursor-pointer items-center gap-2"
						onclick={() => onSystemPromptClick?.()}
					>
						<MessageSquare class="h-4 w-4" />

						<span>{t('chat.form.attachments.system_prompt')}</span>
					</DropdownMenu.Item>
				</Tooltip.Trigger>

				<Tooltip.Content side="right">
					<p>{systemMessageTooltip}</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>
