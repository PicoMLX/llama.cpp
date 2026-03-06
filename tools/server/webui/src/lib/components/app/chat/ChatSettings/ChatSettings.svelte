<script lang="ts">
	import {
		Settings,
		Funnel,
		AlertTriangle,
		Code,
		Monitor,
		ChevronLeft,
		ChevronRight,
		Database
	} from '@lucide/svelte';
	import {
		ChatSettingsFooter,
		ChatSettingsImportExportTab,
		ChatSettingsFields
	} from '$lib/components/app';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { config, settingsStore } from '$lib/stores/settings.svelte';
	import {
		SETTINGS_SECTION_TITLES,
		type SettingsSectionTitle
	} from '$lib/constants/settings-sections';
	import { setMode } from 'mode-watcher';
	import { t } from '$lib/i18n';
	import { ColorMode } from '$lib/enums/ui';
	import { SettingsFieldType } from '$lib/enums/settings';
	import type { Component } from 'svelte';
	import { NUMERIC_FIELDS, POSITIVE_INTEGER_FIELDS } from '$lib/constants/settings-fields';
	import { SETTINGS_COLOR_MODES_CONFIG } from '$lib/constants/settings-config';
	import { SETTINGS_KEYS } from '$lib/constants/settings-keys';

	interface Props {
		onSave?: () => void;
		initialSection?: SettingsSectionTitle;
	}

	let { onSave, initialSection }: Props = $props();

	const settingSections: Array<{
		id: string;
		fields: SettingsFieldConfig[];
		icon: Component;
		titleKey: string;
	}> = [
		{
			id: SETTINGS_SECTION_TITLES.GENERAL,
			titleKey: 'chat.settings.section.general',
			icon: Settings,
			fields: [
				{
					key: SETTINGS_KEYS.THEME,
					label: 'chat.settings.field.theme',
					type: SettingsFieldType.SELECT,
					options: SETTINGS_COLOR_MODES_CONFIG
				},
				{ key: SETTINGS_KEYS.API_KEY, label: 'chat.settings.field.api_key', type: SettingsFieldType.INPUT },
				{
					key: SETTINGS_KEYS.SYSTEM_MESSAGE,
					label: 'chat.settings.field.system_message',
					type: SettingsFieldType.TEXTAREA
				},
				{
					key: SETTINGS_KEYS.PASTE_LONG_TEXT_TO_FILE_LEN,
					label: 'chat.settings.field.paste_long_text_to_file_length',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.COPY_TEXT_ATTACHMENTS_AS_PLAIN_TEXT,
					label: 'chat.settings.field.copy_text_attachments_as_plain_text',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.ENABLE_CONTINUE_GENERATION,
					label: 'chat.settings.field.enable_continue_generation',
					type: SettingsFieldType.CHECKBOX,
					isExperimental: true
				},
				{
					key: SETTINGS_KEYS.PDF_AS_IMAGE,
					label: 'chat.settings.field.parse_pdf_as_image',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.ASK_FOR_TITLE_CONFIRMATION,
					label: 'chat.settings.field.ask_for_title_confirmation',
					type: SettingsFieldType.CHECKBOX
				}
			]
		},
		{
			id: SETTINGS_SECTION_TITLES.DISPLAY,
			titleKey: 'chat.settings.section.display',
			icon: Monitor,
			fields: [
				{
					key: SETTINGS_KEYS.SHOW_MESSAGE_STATS,
					label: 'chat.settings.field.show_message_stats',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.SHOW_THOUGHT_IN_PROGRESS,
					label: 'chat.settings.field.show_thought_in_progress',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.KEEP_STATS_VISIBLE,
					label: 'chat.settings.field.keep_stats_visible',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.AUTO_MIC_ON_EMPTY,
					label: 'chat.settings.field.show_microphone_on_empty',
					type: SettingsFieldType.CHECKBOX,
					isExperimental: true
				},
				{
					key: SETTINGS_KEYS.RENDER_USER_CONTENT_AS_MARKDOWN,
					label: 'chat.settings.field.render_user_content_as_markdown',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.FULL_HEIGHT_CODE_BLOCKS,
					label: 'Use full height code blocks',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.DISABLE_AUTO_SCROLL,
					label: 'chat.settings.field.disable_auto_scroll',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.ALWAYS_SHOW_SIDEBAR_ON_DESKTOP,
					label: 'chat.settings.field.always_show_sidebar_on_desktop',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.AUTO_SHOW_SIDEBAR_ON_NEW_CHAT,
					label: 'chat.settings.field.auto_show_sidebar_on_new_chat',
					type: SettingsFieldType.CHECKBOX
				}
			]
		},
		{
			id: SETTINGS_SECTION_TITLES.SAMPLING,
			titleKey: 'chat.settings.section.sampling',
			icon: Funnel,
			fields: [
				{
					key: SETTINGS_KEYS.TEMPERATURE,
					label: 'chat.settings.field.temperature',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.DYNATEMP_RANGE,
					label: 'chat.settings.field.dynamic_temperature_range',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.DYNATEMP_EXPONENT,
					label: 'chat.settings.field.dynamic_temperature_exponent',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.TOP_K,
					label: 'chat.settings.field.top_k',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.TOP_P,
					label: 'chat.settings.field.top_p',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.MIN_P,
					label: 'chat.settings.field.min_p',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.XTC_PROBABILITY,
					label: 'chat.settings.field.xtc_probability',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.XTC_THRESHOLD,
					label: 'chat.settings.field.xtc_threshold',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.TYP_P,
					label: 'chat.settings.field.typical_p',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.MAX_TOKENS,
					label: 'chat.settings.field.max_tokens',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.SAMPLERS,
					label: 'chat.settings.field.samplers',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.BACKEND_SAMPLING,
					label: 'chat.settings.field.backend_sampling',
					type: SettingsFieldType.CHECKBOX
				}
			]
		},
		{
			id: SETTINGS_SECTION_TITLES.PENALTIES,
			titleKey: 'chat.settings.section.penalties',
			icon: AlertTriangle,
			fields: [
				{
					key: SETTINGS_KEYS.REPEAT_LAST_N,
					label: 'chat.settings.field.repeat_last_n',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.REPEAT_PENALTY,
					label: 'chat.settings.field.repeat_penalty',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.PRESENCE_PENALTY,
					label: 'chat.settings.field.presence_penalty',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.FREQUENCY_PENALTY,
					label: 'chat.settings.field.frequency_penalty',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.DRY_MULTIPLIER,
					label: 'chat.settings.field.dry_multiplier',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.DRY_BASE,
					label: 'chat.settings.field.dry_base',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.DRY_ALLOWED_LENGTH,
					label: 'chat.settings.field.dry_allowed_length',
					type: SettingsFieldType.INPUT
				},
				{
					key: SETTINGS_KEYS.DRY_PENALTY_LAST_N,
					label: 'chat.settings.field.dry_penalty_last_n',
					type: SettingsFieldType.INPUT
				}
			]
		},
		{
			id: SETTINGS_SECTION_TITLES.IMPORT_EXPORT,
			titleKey: 'chat.settings.section.import_export',
			icon: Database,
			fields: []
		},
		{
			id: SETTINGS_SECTION_TITLES.DEVELOPER,
			titleKey: 'chat.settings.section.developer',
			icon: Code,
			fields: [
				{
					key: SETTINGS_KEYS.API_ENDPOINT,
					label: 'chat.settings.field.endpoint',
					type: SettingsFieldType.SELECT,
					options: [
						{ value: 'responses', rawLabel: 'Open Responses (v1/responses)' },
						{ value: 'completions', rawLabel: 'Chat Completions (v1/chat/completions)' }
					]
				},
				{
					key: SETTINGS_KEYS.SHOW_TOOL_CALLS,
					label: 'chat.settings.field.show_tool_call_labels',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.DISABLE_REASONING_PARSING,
					label: 'chat.settings.field.disable_reasoning_parsing',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.SHOW_RAW_OUTPUT_SWITCH,
					label: 'chat.settings.field.show_raw_output_switch',
					type: SettingsFieldType.CHECKBOX
				},
				{
					key: SETTINGS_KEYS.CUSTOM,
					label: 'chat.settings.field.custom_json',
					type: SettingsFieldType.TEXTAREA
				}
			]
		}
		// TODO: Experimental features section will be implemented after initial release
		// This includes Python interpreter (Pyodide integration) and other experimental features
		// {
		// 	title: 'Experimental',
		// 	icon: Beaker,
		// 	fields: [
		// 		{
		// 			key: 'pyInterpreterEnabled',
		// 			label: 'Enable Python interpreter',
		// 			type: 'checkbox'
		// 		}
		// 	]
		// }
	];

	let activeSection = $state(initialSection ?? 'general');
	let currentSection = $derived(
		settingSections.find((section) => section.id === activeSection) || settingSections[0]
	);
	let localConfig: SettingsConfigType = $state({ ...config() });

	let canScrollLeft = $state(false);
	let canScrollRight = $state(false);
	let scrollContainer: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (initialSection) {
			activeSection = initialSection;
		}
	});

	function handleThemeChange(newTheme: string) {
		localConfig.theme = newTheme;

		setMode(newTheme as ColorMode);
	}

	function handleConfigChange(key: string, value: string | boolean) {
		localConfig[key] = value;
	}

	function handleReset() {
		localConfig = { ...config() };

		setMode(localConfig.theme as ColorMode);
	}

	function handleSave() {
		if (localConfig.custom && typeof localConfig.custom === 'string' && localConfig.custom.trim()) {
			try {
				JSON.parse(localConfig.custom);
			} catch (error) {
				alert(t('chat.settings.error.invalid_custom_json'));
				console.error(error);
				return;
			}
		}

		// Convert numeric strings to numbers for numeric fields
		const processedConfig = { ...localConfig };

		for (const field of NUMERIC_FIELDS) {
			if (processedConfig[field] !== undefined && processedConfig[field] !== '') {
				const numValue = Number(processedConfig[field]);
				if (!isNaN(numValue)) {
					if ((POSITIVE_INTEGER_FIELDS as readonly string[]).includes(field)) {
						processedConfig[field] = Math.max(1, Math.round(numValue));
					} else {
						processedConfig[field] = numValue;
					}
				} else {
					alert(t('chat.settings.error.invalid_numeric', { field }));
					return;
				}
			}
		}

		settingsStore.updateMultipleConfig(processedConfig);
		onSave?.();
	}

	function scrollToCenter(element: HTMLElement) {
		if (!scrollContainer) return;

		const containerRect = scrollContainer.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();

		const elementCenter = elementRect.left + elementRect.width / 2;
		const containerCenter = containerRect.left + containerRect.width / 2;
		const scrollOffset = elementCenter - containerCenter;

		scrollContainer.scrollBy({ left: scrollOffset, behavior: 'smooth' });
	}

	function scrollLeft() {
		if (!scrollContainer) return;

		scrollContainer.scrollBy({ left: -250, behavior: 'smooth' });
	}

	function scrollRight() {
		if (!scrollContainer) return;

		scrollContainer.scrollBy({ left: 250, behavior: 'smooth' });
	}

	function updateScrollButtons() {
		if (!scrollContainer) return;

		const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
		canScrollLeft = scrollLeft > 0;
		canScrollRight = scrollLeft < scrollWidth - clientWidth - 1; // -1 for rounding
	}

	export function reset() {
		localConfig = { ...config() };

		setTimeout(updateScrollButtons, 100);
	}

	$effect(() => {
		if (scrollContainer) {
			updateScrollButtons();
		}
	});
</script>

<div class="flex h-full flex-col overflow-hidden md:flex-row">
	<!-- Desktop Sidebar -->
	<div class="hidden w-64 border-r border-border/30 p-6 md:block">
		<nav class="space-y-1 py-2">
			{#each settingSections as section (section.id)}
				<button
					class="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent {activeSection ===
					section.id
						? 'bg-accent text-accent-foreground'
						: 'text-muted-foreground'}"
					onclick={() => (activeSection = section.id)}
				>
					<section.icon class="h-4 w-4" />

					<span class="ml-2">{t(section.titleKey)}</span>
				</button>
			{/each}
		</nav>
	</div>

	<!-- Mobile Header with Horizontal Scrollable Menu -->
	<div class="flex flex-col pt-6 md:hidden">
		<div class="border-b border-border/30 py-4">
			<!-- Horizontal Scrollable Category Menu with Navigation -->
			<div class="relative flex items-center" style="scroll-padding: 1rem;">
				<button
					class="absolute left-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-muted shadow-md backdrop-blur-sm transition-opacity hover:bg-accent {canScrollLeft
						? 'opacity-100'
						: 'pointer-events-none opacity-0'}"
					onclick={scrollLeft}
					aria-label={t('chat.settings.scroll_left')}
				>
					<ChevronLeft class="h-4 w-4" />
				</button>

				<div
					class="scrollbar-hide overflow-x-auto py-2"
					bind:this={scrollContainer}
					onscroll={updateScrollButtons}
				>
					<div class="flex min-w-max gap-2">
						{#each settingSections as section (section.id)}
							<button
								class="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors first:ml-4 last:mr-4 hover:bg-accent {activeSection ===
								section.id
									? 'bg-accent text-accent-foreground'
									: 'text-muted-foreground'}"
								onclick={(e: MouseEvent) => {
									activeSection = section.id;
									scrollToCenter(e.currentTarget as HTMLElement);
								}}
							>
								<section.icon class="h-4 w-4 flex-shrink-0" />
								<span>{t(section.titleKey)}</span>
							</button>
						{/each}
					</div>
				</div>

				<button
					class="absolute right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-muted shadow-md backdrop-blur-sm transition-opacity hover:bg-accent {canScrollRight
						? 'opacity-100'
						: 'pointer-events-none opacity-0'}"
					onclick={scrollRight}
					aria-label={t('chat.settings.scroll_right')}
				>
					<ChevronRight class="h-4 w-4" />
				</button>
			</div>
		</div>
	</div>

	<ScrollArea class="max-h-[calc(100dvh-13.5rem)] flex-1 md:max-h-[calc(100vh-13.5rem)]">
		<div class="space-y-6 p-4 md:p-6">
			<div class="grid">
				<div class="mb-6 flex hidden items-center gap-2 border-b border-border/30 pb-6 md:flex">
					<currentSection.icon class="h-5 w-5" />

					<h3 class="text-lg font-semibold">{t(currentSection.titleKey)}</h3>
				</div>

				{#if currentSection.id === SETTINGS_SECTION_TITLES.IMPORT_EXPORT}
					<ChatSettingsImportExportTab />
				{:else}
					<div class="space-y-6">
						<ChatSettingsFields
							fields={currentSection.fields}
							{localConfig}
							onConfigChange={handleConfigChange}
							onThemeChange={handleThemeChange}
						/>
					</div>
				{/if}
			</div>

			<div class="mt-8 border-t pt-6">
				<p class="text-xs text-muted-foreground">{t('chat.settings.saved_notice')}</p>
			</div>
		</div>
	</ScrollArea>
</div>

<ChatSettingsFooter onReset={handleReset} onSave={handleSave} />
