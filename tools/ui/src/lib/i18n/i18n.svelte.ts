import { getLocaleCandidates } from './locale-utils';
import { browser } from '$app/environment';
import { base } from '$app/paths';

const DEFAULT_LOCALE = 'en';
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

type TranslationParams = Record<string, string | number>;
type Messages = Record<string, string>;
type Catalog = Record<string, Messages>;

const CORE_ENGLISH_MESSAGES: Messages = {
	'chat.form.placeholder': 'Message',
	'chat.form.send': 'Send',
	'chat.form.stop': 'Stop',
	'chat.landing.prompt_no_audio': 'Type a message or add files.',
	'chat.landing.prompt_with_audio': 'Type a message, record audio, or add files.',
	'chat.landing.title': 'Pico',
	'chat.sidebar.empty_no_conversations': 'No Conversations',
	'chat.sidebar.empty_no_results': 'No Results',
	'chat.sidebar.empty_start_typing': 'Type to search conversations.',
	'chat.sidebar.search.placeholder': 'Search conversations',
	'chat.sidebar.search_results': 'Search results',
	'pico.access.cannot_connect': 'Can’t connect to Pico. Check your connection and try again.',
	'pico.access.connect': 'Connect',
	'pico.access.invalid': 'This access key isn’t valid. Check it and try again.',
	'pico.access.label': 'Access Key',
	'pico.access.message': 'Enter the access key shared by the server owner.',
	'pico.access.title': 'Connect to Pico',
	'pico.card.close_preview': 'Close Preview',
	'pico.card.copy': 'Copy',
	'pico.card.copy_failed': 'Couldn’t copy. Try again.',
	'pico.card.copy_success': 'Code copied',
	'pico.card.expand': 'Expand',
	'pico.card.preparing': 'Preparing preview…',
	'pico.card.preview_label': '{name} preview',
	'pico.card.show_code': 'Show Code',
	'pico.card.show_preview': 'Show Preview',
	'pico.card.unavailable': 'Preview unavailable. You can still view and copy the code.',
	'pico.models.description': 'Manage models on this server.',
	'pico.models.empty': 'No Models Available',
	'pico.models.empty_hint': 'Add a model in Pico on the server to start a conversation.',
	'pico.server.help': 'Check that Pico is running on the server, then try again.',
	'pico.server.unavailable': 'Pico Is Unavailable',
	'pico.setup.access_message': 'Open chat with your invitation link to connect to Pico.',
	'pico.setup.access_required': 'Connect to Pico',
	'pico.setup.check_again': 'Check Again',
	'pico.setup.connecting': 'Connecting to Pico…',
	'pico.setup.connection_failed': 'Can’t connect to Pico',
	'pico.setup.connection_message': 'Check your connection and make sure Pico is running.',
	'pico.setup.downloading': 'Downloading {model}…',
	'pico.setup.failed': 'Couldn’t download the model',
	'pico.setup.failed_local': 'Open Pico Settings to try downloading the model again.',
	'pico.setup.failed_remote': 'Ask the person running Pico to retry the download on their Mac.',
	'pico.setup.message': 'Chat opens automatically when your model is ready.',
	'pico.setup.open_chat': 'Open Chat',
	'pico.setup.open_settings': 'Open Pico Settings',
	'pico.setup.opening': 'Opening Pico…',
	'pico.setup.pending_timeout': 'The download hasn’t started. Check Pico on the Mac running it.',
	'pico.setup.position': 'Model {current} of {total}',
	'pico.setup.ready': 'Opening chat…',
	'pico.setup.title': 'Getting Pico ready',
	'pico.setup.try_again': 'Try Again',
	'pico.setup.waiting': 'Waiting for the download to start…',
	'server.error.api_key.auth_failed': 'Authentication failed ({status})',
	'server.error.api_key.cancel': 'Cancel',
	'server.error.api_key.cannot_connect': 'Can\u2019t connect. Check that the server is running.',
	'server.error.api_key.connection_error': 'Can\u2019t connect. Try again.',
	'server.error.api_key.enter': 'Enter API Key',
	'server.error.api_key.generic_error': 'Error: {message}',
	'server.error.api_key.invalid': 'The API key isn\u2019t valid. Check it and try again.',
	'server.error.api_key.label': 'API Key',
	'server.error.api_key.placeholder': 'Enter your API key\u2026',
	'server.error.api_key.save_retry': 'Save and Reconnect',
	'server.error.api_key.success': 'API key accepted. Connecting\u2026',
	'server.error.api_key.success_button': 'Connected',
	'server.error.api_key.validating': 'Checking API Key\u2026',
	'server.error.retry.action': 'Reconnect',
	'server.error.retry.connecting': 'Connecting\u2026',
	'server.error.title': 'Server Connection Error',
	'server.error.troubleshooting.or': 'or',
	'server.error.troubleshooting.start': 'Start the server:',
	'server.error.troubleshooting.step_logs': 'Check the server logs for errors.',
	'server.error.troubleshooting.step_network': 'Check your network connection.',
	'server.error.troubleshooting.step_url': 'Check the server address.',
	'server.error.troubleshooting.title': 'Troubleshooting',
	'server.loading.message': 'Connecting to Pico\u2026',
	'server.loading.title': 'Connecting to Server'
};

function interpolate(value: string, params?: TranslationParams): string {
	if (!params) return value;

	return value.replace(/\{(\w+)\}/g, (match, key) => {
		const replacement = params[key];

		return replacement === undefined ? match : String(replacement);
	});
}

class I18nStore {
	isLoading = $state(false);
	isReady = $state(false);
	locale = $state(DEFAULT_LOCALE);
	messages = $state<Catalog>({ [DEFAULT_LOCALE]: CORE_ENGLISH_MESSAGES });
	private initialized = false;
	private loadedLocales = new Set<string>();

	init() {
		if (!browser || this.initialized) return;

		this.initialized = true;

		const preferredLocale = navigator.languages?.[0] || navigator.language || DEFAULT_LOCALE;

		void this.setLocale(preferredLocale);
	}

	async setLocale(value: string) {
		// Always load English fallback first to ensure complete translation coverage
		if (!this.loadedLocales.has(DEFAULT_LOCALE)) {
			await this.fetchLocale(DEFAULT_LOCALE);
		}

		const candidates = getLocaleCandidates(value);
		const resolved = await this.loadFirstAvailable(candidates);

		this.locale = resolved;
		this.isReady = true;

		if (browser) {
			document.documentElement.lang = resolved;
			document.documentElement.dir = RTL_LANGUAGES.has(resolved.split('-')[0]) ? 'rtl' : 'ltr';
		}
	}

	t(key: string, params?: TranslationParams): string {
		const primary = this.messages[this.locale];
		const fallback = this.messages[DEFAULT_LOCALE];
		const value = primary?.[key] ?? fallback?.[key] ?? key;

		return interpolate(value, params);
	}

	private async fetchLocale(locale: string): Promise<boolean> {
		if (!browser) return false;

		this.isLoading = true;
		try {
			const response = await fetch(`${base}/locales/${locale}.json`);

			if (!response.ok) {
				return false;
			}

			const data = (await response.json()) as Messages;

			if (!data || typeof data !== 'object') {
				return false;
			}

			this.messages = { ...this.messages, [locale]: data };
			this.loadedLocales.add(locale);

			return true;
		} catch {
			return false;
		} finally {
			this.isLoading = false;
		}
	}

	private async loadFirstAvailable(candidates: string[]): Promise<string> {
		for (const locale of candidates) {
			if (this.loadedLocales.has(locale)) {
				return locale;
			}

			if (await this.fetchLocale(locale)) {
				return locale;
			}
		}

		return DEFAULT_LOCALE;
	}
}

export const i18n = new I18nStore();
export const t = (key: string, params?: TranslationParams) => i18n.t(key, params);
