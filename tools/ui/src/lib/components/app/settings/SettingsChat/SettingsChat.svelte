<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import { base } from '$app/paths';
	import {
		SettingsChatDesktopSidebar,
		SettingsChatFields,
		SettingsChatImportExportTab,
		SettingsChatMobileHeader,
		SettingsChatToolsTab,
		SettingsFooter,
		SettingsMcpServers,
		SettingsResetButton
	} from '$lib/components/app/settings';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import Label from '$lib/components/ui/label/label.svelte';
	import {
		HEADERS,
		IS_PICO_BUILD,
		NUMERIC_FIELDS,
		PICO_ADVANCED_SETTINGS_GROUPS,
		POSITIVE_INTEGER_FIELDS,
		SETTINGS_CHAT_SECTIONS,
		SETTINGS_ENTRIES_BY_KEY,
		SETTINGS_KEYS,
		SETTINGS_SECTION_SLUGS
	} from '$lib/constants';
	import { ColorMode } from '$lib/enums/ui.enums';
	import {
		conversationsStore,
		modelsStore,
		serverStore,
		settingsStore,
		uiStore
	} from '$lib/stores';
	import type { SettingsConfigValue, SettingsSection, SettingsSectionTitle } from '$lib/types';
	import { setMode } from 'mode-watcher';
	import { fade } from 'svelte/transition';
	interface Props {
		initialSection?: string;
		onSectionChange?: (section: SettingsSectionTitle) => void;
		onClose?: () => void;
	}

	let { initialSection, onClose, onSectionChange }: Props = $props();

	let activeSlug = $derived(initialSection ?? 'general');

	function handleSectionChange(section: SettingsSectionTitle) {
		const found = SETTINGS_CHAT_SECTIONS.find((s) => s.title === section);

		if (found) {
			activeSlug = found.slug;
		}

		onSectionChange?.(section);
	}

	let currentSection = $derived(
		SETTINGS_CHAT_SECTIONS.find((section) => section.slug === activeSlug) ||
			SETTINGS_CHAT_SECTIONS[0]
	);

	let baselineConfig: SettingsConfigType = $state({ ...settingsStore.config });
	let localConfig: SettingsConfigType = $state({ ...settingsStore.config });

	// inputs hand back strings for numeric fields, so compare stringified values
	let changedConfig = $derived.by(() => {
		const changes: Partial<SettingsConfigType> = {};
		const keys = new Set([...Object.keys(baselineConfig), ...Object.keys(localConfig)]);

		for (const key of keys) {
			if (String(localConfig[key] ?? '') !== String(baselineConfig[key] ?? '')) {
				changes[key] = localConfig[key];
			}
		}

		return changes;
	});
	let hasChanges = $derived(Object.keys(changedConfig).length > 0);

	let fieldErrors: Record<string, string> = $state({});
	let accessKey = $state('');
	let accessError = $state('');
	let connecting = $state(false);
	let accessConnected = $state(false);

	$effect(() => {
		if (!IS_PICO_BUILD) return;

		for (const [key, value] of Object.entries(settingsStore.config)) {
			baselineConfig[key] = value;

			const draft = localConfig[key];
			const keepNumericDraft =
				typeof value === 'number' &&
				typeof draft === 'string' &&
				draft.trim() !== '' &&
				Number(draft) === value;

			if (!fieldErrors[key] && !keepNumericDraft) localConfig[key] = value;
		}
	});

	function savePreference(key: string, value: SettingsConfigValue) {
		const entry = SETTINGS_ENTRIES_BY_KEY[key];

		let savedValue = value;
		let error = '';

		if ((NUMERIC_FIELDS as readonly string[]).includes(key)) {
			if (String(value ?? '').trim() === '') {
				if (entry.sync) savedValue = '';
				else error = 'Enter a number.';
			} else {
				const number = Number(value);

				if (!Number.isFinite(number)) error = 'Enter a valid number.';
				else if (
					entry.isPositiveInteger &&
					(!Number.isInteger(number) || number < (entry.min ?? 1))
				) {
					error = `Enter a whole number of at least ${entry.min ?? 1}.`;
				} else if (entry.max !== undefined && number > entry.max) {
					error = `Enter a number no greater than ${entry.max}.`;
				} else savedValue = number;
			}
		}

		if (key === SETTINGS_KEYS.CUSTOM_JSON && typeof value === 'string' && value.trim()) {
			try {
				JSON.parse(value);
			} catch {
				error = 'Enter valid JSON. Your previous value is still saved.';
			}
		}

		if (error) {
			fieldErrors[key] = error;

			return;
		}

		delete fieldErrors[key];
		settingsStore.updateConfig(key, savedValue);
	}

	async function connectAccessKey(event: SubmitEvent) {
		event.preventDefault();

		if (connecting || !accessKey.trim()) return;

		connecting = true;
		accessError = '';
		accessConnected = false;

		try {
			const response = await fetch(`${base}/props`, {
				headers: { [HEADERS.AUTHORIZATION]: `${HEADERS.BEARER}${accessKey.trim()}` }
			});

			if (!response.ok) {
				accessError =
					response.status === 401 || response.status === 403
						? 'This access key is not valid. Check it and try again.'
						: 'Could not connect to Pico. Try again.';

				return;
			}

			settingsStore.updateConfig(SETTINGS_KEYS.API_KEY, accessKey.trim());
			accessKey = '';
			accessConnected = true;
		} catch {
			accessError = 'Could not connect to Pico. Check your connection and try again.';
		} finally {
			connecting = false;
		}
	}

	function handleManageChats() {
		onClose?.();
		uiStore.isSidebarExpanded = true;
		uiStore.chatManagementRequested = true;
	}

	function handleParameterReset(key: string) {
		settingsStore.resetSettingsForKeys([key]);
		delete fieldErrors[key];
		localConfig[key] = settingsStore.config[key];
	}

	function handleSectionReset(fields: SettingsFieldConfig[]) {
		for (const field of fields) {
			delete fieldErrors[field.key];
			localConfig[field.key] = settingsStore.config[field.key];
		}
	}

	let mobileHeader: { updateCarousel: () => void } | undefined;

	let fetchInitiated = false;

	$effect(() => {
		if (serverStore.isRouterMode && currentSection.fields?.length && !fetchInitiated) {
			fetchInitiated = true;

			void modelsStore
				.fetch()
				.then(() => modelsStore.fetchRouterModels())
				.then(() => modelsStore.props.fetchModalitiesForLoadedModels())
				.then(() => modelsStore.ensureFirstModelSelected());
		}
	});

	function handleThemeChange(newTheme: string) {
		if (IS_PICO_BUILD) handleConfigChange(SETTINGS_KEYS.THEME, newTheme);
		else localConfig.theme = newTheme;

		setMode(newTheme as ColorMode);
	}

	function handleConfigChange(key: string, value: string | boolean) {
		localConfig[key] = value;

		// discover needs the hub metadata reads: checking it turns the hub on,
		// unchecking it turns the hub back off, so the checkbox never lies
		if (key === SETTINGS_KEYS.ENABLE_DISCOVER_MODELS) {
			localConfig[SETTINGS_KEYS.USE_HUGGING_FACE_HUB] = value === true;

			if (IS_PICO_BUILD) savePreference(SETTINGS_KEYS.USE_HUGGING_FACE_HUB, value === true);
		}

		if (IS_PICO_BUILD) savePreference(key, value);
	}

	function handleReset() {
		reset();
		setMode(localConfig.theme as ColorMode);
		mobileHeader?.updateCarousel();
	}

	function handleSave() {
		const processedConfig = { ...changedConfig };

		if (
			processedConfig.customJson &&
			typeof processedConfig.customJson === 'string' &&
			processedConfig.customJson.trim()
		) {
			try {
				JSON.parse(processedConfig.customJson);
			} catch (error) {
				alert('Invalid JSON in custom parameters. Please check the format and try again.');
				console.error(error);

				return;
			}
		}

		for (const field of NUMERIC_FIELDS) {
			if (processedConfig[field] !== undefined && processedConfig[field] !== '') {
				const numValue = Number(processedConfig[field]);

				if (!isNaN(numValue)) {
					if ((POSITIVE_INTEGER_FIELDS as readonly string[]).includes(field)) {
						const entryByMinMax = SETTINGS_CHAT_SECTIONS.flatMap(
							(section) => section.fields ?? []
						).find((entry) => entry.key === field);
						const lo = entryByMinMax?.min ?? 1;
						const hi = entryByMinMax?.max ?? Number.POSITIVE_INFINITY;

						processedConfig[field] = Math.max(lo, Math.min(hi, Math.round(numValue)));
					} else {
						processedConfig[field] = numValue;
					}
				} else {
					alert(`Invalid numeric value for ${field}. Please enter a valid number.`);

					return;
				}
			}
		}

		settingsStore.updateMultipleConfig(processedConfig);
		reset();
		onClose?.();
	}

	export function reset() {
		baselineConfig = { ...settingsStore.config };
		localConfig = { ...baselineConfig };
		fieldErrors = {};
	}
</script>

{#snippet preferenceFields(fields: SettingsFieldConfig[], title: string)}
	<SettingsChatFields
		errors={fieldErrors}
		{fields}
		{localConfig}
		onConfigChange={handleConfigChange}
		onParameterReset={handleParameterReset}
		onThemeChange={handleThemeChange}
	/>

	<SettingsResetButton
		hasDraftChanges={fields.some((field) => Boolean(fieldErrors[field.key]))}
		keys={fields.map((field) => field.key)}
		onReset={() => handleSectionReset(fields)}
		sectionTitle={title}
	/>
{/snippet}

<div in:fade={{ duration: 150 }} class="mx-auto flex h-full w-full flex-col">
	<div class="flex flex-1 flex-col md:flex-row md:gap-4">
		<SettingsChatDesktopSidebar
			isActive={(section: SettingsSection) => section.slug === activeSlug}
			onSectionChange={handleSectionChange}
			sections={SETTINGS_CHAT_SECTIONS}
		/>

		<SettingsChatMobileHeader
			bind:this={mobileHeader}
			isActive={(section: SettingsSection) => section.slug === activeSlug}
			onSectionChange={handleSectionChange}
			sections={SETTINGS_CHAT_SECTIONS}
		/>

		<div class="mx-auto max-w-2xl px-4 flex-1 md:mt-4">
			<div class="space-y-6 pt-3">
				<div class="grid">
					{#if currentSection.slug === SETTINGS_SECTION_SLUGS.CONNECTIONS}
						<div class="space-y-4">
							<div class="space-y-1">
								<h2 class="text-lg font-semibold">Connections</h2>

								<p class="text-sm text-muted-foreground">
									Connect apps and services to use their tools in chats.
								</p>
							</div>

							<SettingsMcpServers />

							<details class="rounded-lg border border-border/50 p-4">
								<summary class="cursor-pointer text-sm font-medium"
									>{conversationsStore.activeConversation
										? 'Tools for this chat'
										: 'Tool defaults'}</summary
								>

								<div class="mt-4"><SettingsChatToolsTab /></div>
							</details>

							<details class="rounded-lg border border-border/50 p-4">
								<summary class="cursor-pointer text-sm font-medium">Pico access</summary>

								<form class="mt-4 space-y-3" onsubmit={connectAccessKey}>
									<p class="text-sm text-muted-foreground">
										Change the access key used to connect to this Pico server.
									</p>

									<Label for="pico-settings-access-key">Access key</Label>

									<Input
										bind:value={accessKey}
										aria-describedby={accessError ? 'pico-settings-access-error' : undefined}
										aria-invalid={Boolean(accessError) || undefined}
										autocomplete="new-password"
										disabled={connecting}
										id="pico-settings-access-key"
										type="password"
									/>

									{#if accessError}<p
											class="text-sm text-destructive"
											id="pico-settings-access-error"
											role="alert"
										>
											{accessError}
										</p>{/if}

									{#if accessConnected}<p class="text-sm text-muted-foreground" role="status">
											Connected to Pico.
										</p>{/if}

									<Button disabled={connecting || !accessKey.trim()} type="submit"
										>{connecting ? 'Connecting...' : 'Connect'}</Button
									>
								</form>
							</details>
						</div>
					{:else if IS_PICO_BUILD && currentSection.slug === SETTINGS_SECTION_SLUGS.DATA}
						<div class="space-y-6">
							<Button onclick={handleManageChats} variant="outline">Manage chats</Button>

							<SettingsChatImportExportTab scope="conversations" />
						</div>
					{:else if IS_PICO_BUILD && currentSection.slug === SETTINGS_SECTION_SLUGS.ADVANCED}
						<div class="space-y-4">
							<p class="text-sm text-muted-foreground">
								These preferences apply across chats. Leave generation fields blank to use the
								model's defaults. Tool choices and saved instructions in existing chats stay with
								those chats.
							</p>

							{#each PICO_ADVANCED_SETTINGS_GROUPS as group (group.title)}
								<details class="rounded-lg border border-border/50 p-4">
									<summary class="cursor-pointer text-sm font-medium">{group.title}</summary>

									<div class="mt-5 space-y-6">
										{@render preferenceFields(group.fields, group.title)}
									</div>
								</details>
							{/each}

							<details class="rounded-lg border border-border/50 p-4">
								<summary class="cursor-pointer text-sm font-medium">Settings backup</summary>

								<div class="mt-5">
									<SettingsChatImportExportTab onSettingsImport={reset} scope="settings" />
								</div>
							</details>
						</div>
					{:else if IS_PICO_BUILD && currentSection.fields}
						<div class="space-y-6">
							{@render preferenceFields(currentSection.fields, currentSection.title)}
						</div>
					{:else if currentSection.slug === SETTINGS_SECTION_SLUGS.TOOLS}
						<SettingsChatToolsTab />
					{:else if currentSection.slug === SETTINGS_SECTION_SLUGS.IMPORT_EXPORT}
						<SettingsChatImportExportTab />
					{:else if currentSection.fields}
						<div class="space-y-6">
							<SettingsChatFields
								fields={currentSection.fields}
								{localConfig}
								onConfigChange={handleConfigChange}
								onThemeChange={handleThemeChange}
							/>

							{#if currentSection.slug === SETTINGS_SECTION_SLUGS.GENERAL}
								<div class="flex justify-end gap-2">
									<SettingsResetButton onReset={handleReset} />

									<Button onclick={() => window.location.reload()} variant="outline">
										<RefreshCw class="h-3 w-3" />
										Reload app
									</Button>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="mt-8 border-t border-border/30 pt-6 pb-6">
					<p class="text-xs text-muted-foreground">
						{IS_PICO_BUILD
							? Object.keys(fieldErrors).length > 0
								? 'Correct the highlighted values to save them.'
								: 'Changes save automatically in this browser.'
							: "Settings are saved in browser's localStorage"}
					</p>
				</div>
			</div>

			{#if !IS_PICO_BUILD}
				<SettingsFooter {hasChanges} onSave={handleSave} />
			{/if}
		</div>
	</div>
</div>
