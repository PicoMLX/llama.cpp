export const PICO_CARD_KIND_ATTR = 'data-pico-card';
export const PICO_CARD_SOURCE_ATTR = 'data-pico-source';
export const PICO_CARD_SELECTOR = `[${PICO_CARD_KIND_ATTR}]`;

export type PicoCardKind = 'vega-lite' | 'html-preview' | 'openui';

export interface PicoCardAction {
	type: string;
	params?: Record<string, unknown>;
	humanFriendlyMessage?: string;
	formState?: Record<string, unknown>;
	formName?: string;
}

export interface PicoCardContext {
	id: string;
	dark: boolean;
	width: number;
	signal: AbortSignal;
	onAction?: (action: PicoCardAction) => void;
}

export interface PicoCardHandle {
	dispose(): void;
	update?(context: PicoCardContext): void | Promise<void>;
}

export type PicoCardRenderer = (
	host: HTMLElement,
	source: string,
	context: PicoCardContext
) => Promise<PicoCardHandle>;

export type PicoCardRegistry = Partial<Record<PicoCardKind, PicoCardRenderer>>;

export interface PicoCardSyncOptions {
	dark: boolean;
	onAction?: (action: PicoCardAction) => void;
}
