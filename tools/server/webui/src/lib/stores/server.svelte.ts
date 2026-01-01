import { PropsService } from '$lib/services/props';
import { ServerRole } from '$lib/enums';

/**
 * serverStore - Server connection state, configuration, and role detection
 *
 * This store manages the server connection state and properties fetched from `/props`.
 * It provides reactive state for server configuration and role detection.
 *
 * **Architecture & Relationships:**
 * - **PropsService**: Stateless service for fetching `/props` data
 * - **serverStore** (this class): Reactive store for server state
 * - **modelsStore**: Independent store for model management (uses PropsService directly)
 *
 * **Key Features:**
 * - **Server State**: Connection status, loading, error handling
 * - **Role Detection**: MODEL (single model) vs ROUTER (multi-model)
 * - **Default Params**: Server-wide generation defaults
 */
class ServerStore {
	// ─────────────────────────────────────────────────────────────────────────────
	// State
	// ─────────────────────────────────────────────────────────────────────────────

	props = $state<ApiLlamaCppServerProps | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	role = $state<ServerRole | null>(null);
	private fetchPromise: Promise<void> | null = null;

	// ─────────────────────────────────────────────────────────────────────────────
	// Getters
	// ─────────────────────────────────────────────────────────────────────────────

	get defaultParams(): ApiLlamaCppServerProps['default_generation_settings']['params'] | null {
		return this.props?.default_generation_settings?.params || null;
	}

	get contextSize(): number | null {
		return this.props?.default_generation_settings?.n_ctx ?? null;
	}

	get webuiSettings(): Record<string, string | number | boolean> | undefined {
		return this.props?.webui_settings;
	}

	get isRouterMode(): boolean {
		return this.role === ServerRole.ROUTER;
	}

	get isModelMode(): boolean {
		return this.role === ServerRole.MODEL;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Data Handling
	// ─────────────────────────────────────────────────────────────────────────────

	async fetch(): Promise<void> {
		if (this.fetchPromise) return this.fetchPromise;

<<<<<<< HEAD
	get modelName(): string | null {
		if (this._serverProps?.model_alias) {
			return this._serverProps.model_alias;
		}
		if (!this._serverProps?.model_path) return null;
		return this._serverProps.model_path.split(/(\\|\/)/).pop() || null;
	}

	get supportedModalities(): string[] {
		const modalities: string[] = [];
		if (this._serverProps?.modalities?.audio) {
			modalities.push('audio');
		}
		if (this._serverProps?.modalities?.vision) {
			modalities.push('vision');
		}
		return modalities;
	}

	get supportsVision(): boolean {
		return this._serverProps?.modalities?.vision ?? false;
	}

	get supportsAudio(): boolean {
		return this._serverProps?.modalities?.audio ?? false;
	}

	get slotsEndpointAvailable(): boolean | null {
		return this._slotsEndpointAvailable;
	}

	get serverDefaultParams():
		| ApiLlamaCppServerProps['default_generation_settings']['params']
		| null {
		return this._serverProps?.default_generation_settings?.params || null;
	}

	get serverName(): string {
		return this._serverProps?.server_name || 'Pico AI Server';
	}

	/**
	 * Check if slots endpoint is available based on server properties and endpoint support
	 */
	private async checkSlotsEndpointAvailability(): Promise<void> {
		if (!this._serverProps) {
			this._slotsEndpointAvailable = false;
			return;
		}

		if (this._serverProps.total_slots <= 0) {
			this._slotsEndpointAvailable = false;
			return;
		}

		try {
			const currentConfig = config();
			const apiKey = currentConfig.apiKey?.toString().trim();

			const response = await fetch(`./slots`, {
				headers: {
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
				}
			});

			if (response.status === 501) {
				console.info('Slots endpoint not implemented - server started without --slots flag');
				this._slotsEndpointAvailable = false;
				return;
			}

			this._slotsEndpointAvailable = true;
		} catch (error) {
			console.warn('Unable to test slots endpoint availability:', error);
			this._slotsEndpointAvailable = false;
		}
	}

	/**
	 * Fetches server properties from the server
	 */
	async fetchServerProps(options: { silent?: boolean } = {}): Promise<void> {
		const { silent = false } = options;
		const isSilent = silent && this._serverProps !== null;

		if (this.fetchServerPropsPromise) {
			return this.fetchServerPropsPromise;
		}

		if (!isSilent) {
			this._loading = true;
			this._error = null;
			this._serverWarning = null;
		}

		const hadProps = this._serverProps !== null;
=======
		this.loading = true;
		this.error = null;
>>>>>>> master

		const fetchPromise = (async () => {
			try {
				const props = await PropsService.fetch();
				this.props = props;
				this.error = null;
				this.detectRole(props);
			} catch (error) {
				this.error = this.getErrorMessage(error);
				console.error('Error fetching server properties:', error);
			} finally {
				this.loading = false;
				this.fetchPromise = null;
			}
		})();

		this.fetchPromise = fetchPromise;
		await fetchPromise;
	}

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			const message = error.message || '';

			if (error.name === 'TypeError' && message.includes('fetch')) {
				return 'Server is not running or unreachable';
			} else if (message.includes('ECONNREFUSED')) {
				return 'Connection refused - server may be offline';
			} else if (message.includes('ENOTFOUND')) {
				return 'Server not found - check server address';
			} else if (message.includes('ETIMEDOUT')) {
				return 'Request timed out';
			} else if (message.includes('503')) {
				return 'Server temporarily unavailable';
			} else if (message.includes('500')) {
				return 'Server error - check server logs';
			} else if (message.includes('404')) {
				return 'Server endpoint not found';
			} else if (message.includes('403') || message.includes('401')) {
				return 'Access denied';
			}
		}

		return 'Failed to connect to server';
	}

	clear(): void {
		this.props = null;
		this.error = null;
		this.loading = false;
		this.role = null;
		this.fetchPromise = null;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────────

	private detectRole(props: ApiLlamaCppServerProps): void {
		const newRole = props?.role === ServerRole.ROUTER ? ServerRole.ROUTER : ServerRole.MODEL;
		if (this.role !== newRole) {
			this.role = newRole;
			console.info(`Server running in ${newRole === ServerRole.ROUTER ? 'ROUTER' : 'MODEL'} mode`);
		}
	}
}

export const serverStore = new ServerStore();

export const serverProps = () => serverStore.props;
export const serverLoading = () => serverStore.loading;
export const serverError = () => serverStore.error;
<<<<<<< HEAD
export const serverWarning = () => serverStore.serverWarning;
export const modelName = () => serverStore.modelName;
export const supportedModalities = () => serverStore.supportedModalities;
export const supportsVision = () => serverStore.supportsVision;
export const supportsAudio = () => serverStore.supportsAudio;
export const slotsEndpointAvailable = () => serverStore.slotsEndpointAvailable;
export const serverDefaultParams = () => serverStore.serverDefaultParams;
export const serverName = () => serverStore.serverName;
=======
export const serverRole = () => serverStore.role;
export const defaultParams = () => serverStore.defaultParams;
export const contextSize = () => serverStore.contextSize;
export const isRouterMode = () => serverStore.isRouterMode;
export const isModelMode = () => serverStore.isModelMode;
>>>>>>> master
