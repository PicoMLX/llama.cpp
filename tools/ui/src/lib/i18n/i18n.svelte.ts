import { getLocaleCandidates } from './locale-utils';
import { browser } from '$app/environment';
import { base } from '$app/paths';

const DEFAULT_LOCALE = 'en';
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

type TranslationParams = Record<string, string | number>;
type Messages = Record<string, string>;
type Catalog = Record<string, Messages>;

const CORE_ENGLISH_MESSAGES: Messages = {
	'chat.form.placeholder': 'Type a message...',
	'chat.form.send': 'Send',
	'chat.form.stop': 'Stop',
	'chat.landing.prompt_no_audio': 'Type a message or upload files to get started',
	'chat.landing.prompt_with_audio': 'Record audio, type a message, or upload files to get started',
	'chat.landing.title': 'Pico',
	'chat.sidebar.empty_no_conversations': 'No conversations yet',
	'chat.sidebar.empty_no_results': 'No results found',
	'chat.sidebar.empty_start_typing': 'Start typing to see results',
	'chat.sidebar.search.placeholder': 'Search conversations...',
	'chat.sidebar.search_results': 'Search results',
	'server.error.api_key.auth_failed': 'Authentication failed ({status})',
	'server.error.api_key.cancel': 'Cancel',
	'server.error.api_key.cannot_connect': 'Cannot connect to server - check if server is running',
	'server.error.api_key.connection_error': 'Connection error - please try again',
	'server.error.api_key.enter': 'Enter API Key',
	'server.error.api_key.generic_error': 'Error: {message}',
	'server.error.api_key.invalid': 'Invalid API key - please check and try again',
	'server.error.api_key.label': 'API Key',
	'server.error.api_key.placeholder': 'Enter your API key...',
	'server.error.api_key.save_retry': 'Save & Retry',
	'server.error.api_key.success': 'API key validated successfully! Connecting...',
	'server.error.api_key.success_button': 'Success!',
	'server.error.api_key.validating': 'Validating...',
	'server.error.retry.action': 'Retry Connection',
	'server.error.retry.connecting': 'Connecting...',
	'server.error.title': 'Server Connection Error',
	'server.error.troubleshooting.or': 'or',
	'server.error.troubleshooting.start': 'Start the llama-server:',
	'server.error.troubleshooting.step_logs': 'Check server logs for any error messages',
	'server.error.troubleshooting.step_network': 'Verify your network connection',
	'server.error.troubleshooting.step_url': 'Check that the server is accessible at the correct URL',
	'server.error.troubleshooting.title': 'Troubleshooting',
	'server.loading.message': 'Initializing connection to Pico server...',
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
	locale = $state(DEFAULT_LOCALE);
	messages = $state<Catalog>({ [DEFAULT_LOCALE]: CORE_ENGLISH_MESSAGES });
	isReady = $state(false);
	isLoading = $state(false);
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
}

export const i18n = new I18nStore();
export const t = (key: string, params?: TranslationParams) => i18n.t(key, params);
