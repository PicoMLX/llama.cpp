import { ColorMode } from '$lib/enums/ui';
import { Monitor, Moon, Sun } from '@lucide/svelte';

export const SETTING_CONFIG_DEFAULT: Record<string, string | number | boolean | undefined> = {
	// Note: in order not to introduce breaking changes, please keep the same data type (number, string, etc) if you want to change the default value.
	// Do not use nested objects, keep it single level. Prefix the key if you need to group them.
	apiKey: '',
	apiEndpoint: 'responses',
	systemMessage: '',
	showSystemMessage: true,
	theme: ColorMode.SYSTEM,
	showThoughtInProgress: false,
	disableReasoningParsing: false,
	showRawOutputSwitch: false,
	keepStatsVisible: false,
	showMessageStats: true,
	askForTitleConfirmation: false,
	pasteLongTextToFileLen: 2500,
	copyTextAttachmentsAsPlainText: false,
	pdfAsImage: false,
	disableAutoScroll: false,
	renderUserContentAsMarkdown: false,
	alwaysShowSidebarOnDesktop: false,
	autoShowSidebarOnNewChat: false,
	autoMicOnEmpty: false,
	fullHeightCodeBlocks: false,
	showRawModelNames: false,
	mcpServers: '[]',
	mcpServerUsageStats: '{}', // JSON object: { [serverId]: usageCount }
	agenticMaxTurns: 10,
	agenticMaxToolPreviewLines: 25,
	showToolCallInProgress: false,
	alwaysShowAgenticTurns: false,
	// sampling params: empty means "use server default"
	// the server / preset is the source of truth
	// empty values are shown as placeholders from /props in the UI
	// and are NOT sent in API requests, letting the server decide
	samplers: '',
	backend_sampling: false,
	temperature: undefined,
	dynatemp_range: undefined,
	dynatemp_exponent: undefined,
	top_k: undefined,
	top_p: undefined,
	min_p: undefined,
	xtc_probability: undefined,
	xtc_threshold: undefined,
	typ_p: undefined,
	repeat_last_n: undefined,
	repeat_penalty: undefined,
	presence_penalty: undefined,
	frequency_penalty: undefined,
	dry_multiplier: undefined,
	dry_base: undefined,
	dry_allowed_length: undefined,
	dry_penalty_last_n: undefined,
	max_tokens: undefined,
	custom: '', // custom json-stringified object
	// experimental features
	pyInterpreterEnabled: false,
	enableContinueGeneration: false
};

export const SETTING_CONFIG_INFO: Record<string, string> = {
	apiKey: 'chat.settings.help.api_key',
	apiEndpoint: 'chat.settings.help.endpoint',
	systemMessage: 'chat.settings.help.system_message',
	showSystemMessage: 'chat.settings.help.show_system_message',
	theme: 'chat.settings.help.theme',
	pasteLongTextToFileLen: 'chat.settings.help.paste_long_text_to_file_length',
	copyTextAttachmentsAsPlainText: 'chat.settings.help.copy_text_attachments_as_plain_text',
	samplers: 'chat.settings.help.samplers',
	backend_sampling: 'chat.settings.help.backend_sampling',
	temperature: 'chat.settings.help.temperature',
	dynatemp_range: 'chat.settings.help.dynamic_temperature_range',
	dynatemp_exponent: 'chat.settings.help.dynamic_temperature_exponent',
	top_k: 'chat.settings.help.top_k',
	top_p: 'chat.settings.help.top_p',
	min_p: 'chat.settings.help.min_p',
	xtc_probability: 'chat.settings.help.xtc_probability',
	xtc_threshold: 'chat.settings.help.xtc_threshold',
	typ_p: 'chat.settings.help.typical_p',
	repeat_last_n: 'chat.settings.help.repeat_last_n',
	repeat_penalty: 'chat.settings.help.repeat_penalty',
	presence_penalty: 'chat.settings.help.presence_penalty',
	frequency_penalty: 'chat.settings.help.frequency_penalty',
	dry_multiplier: 'chat.settings.help.dry_multiplier',
	dry_base: 'chat.settings.help.dry_base',
	dry_allowed_length: 'chat.settings.help.dry_allowed_length',
	dry_penalty_last_n: 'chat.settings.help.dry_penalty_last_n',
	max_tokens: 'chat.settings.help.max_tokens',
	custom: 'chat.settings.help.custom_json',
	showThoughtInProgress: 'chat.settings.help.show_thought_in_progress',
	showToolCalls: 'chat.settings.help.show_tool_calls',
	disableReasoningParsing: 'chat.settings.help.disable_reasoning_parsing',
	showRawOutputSwitch: 'chat.settings.help.show_raw_output_switch',
	keepStatsVisible: 'chat.settings.help.keep_stats_visible',
	showMessageStats: 'chat.settings.help.show_message_stats',
	askForTitleConfirmation: 'chat.settings.help.ask_for_title_confirmation',
	pdfAsImage: 'chat.settings.help.parse_pdf_as_image',
	disableAutoScroll: 'chat.settings.help.disable_auto_scroll',
	renderUserContentAsMarkdown: 'chat.settings.help.render_user_content_as_markdown',
	alwaysShowSidebarOnDesktop: 'chat.settings.help.always_show_sidebar_on_desktop',
	autoShowSidebarOnNewChat: 'chat.settings.help.auto_show_sidebar_on_new_chat',
	autoMicOnEmpty: 'chat.settings.help.show_microphone_on_empty',
	fullHeightCodeBlocks: 'chat.settings.help.full_height_code_blocks',
	showRawModelNames:
		'Display full raw model identifiers (e.g. "ggml-org/GLM-4.7-Flash-GGUF:Q8_0") instead of parsed names with badges.',
	mcpServers:
		'Configure MCP servers as a JSON list. Use the form in the MCP Client settings section to edit.',
	mcpServerUsageStats:
		'Usage statistics for MCP servers. Tracks how many times tools from each server have been used.',
	agenticMaxTurns:
		'Maximum number of tool execution cycles before stopping (prevents infinite loops).',
	agenticMaxToolPreviewLines:
		'Number of lines shown in tool output previews (last N lines). Only these previews and the final LLM response persist after the agentic loop completes.',
	showToolCallInProgress:
		'Automatically expand tool call details while executing and keep them expanded after completion.',
	alwaysShowAgenticTurns: 'Always keep agentic turn content expanded in conversation history.',
	pyInterpreterEnabled: 'chat.settings.help.py_interpreter_enabled',
	enableContinueGeneration: 'chat.settings.help.enable_continue_generation'
};

export const SETTINGS_COLOR_MODES_CONFIG = [
	{ value: ColorMode.SYSTEM, label: 'System', icon: Monitor },
	{ value: ColorMode.LIGHT, label: 'Light', icon: Sun },
	{ value: ColorMode.DARK, label: 'Dark', icon: Moon }
];
