import {
	PICO_CARD_KIND_ATTR,
	PICO_CARD_SELECTOR,
	PICO_CARD_SOURCE_ATTR,
	type PicoCardContext,
	type PicoCardHandle,
	type PicoCardKind,
	type PicoCardRegistry,
	type PicoCardSyncOptions
} from './types';
import { copyToClipboard } from '$lib/utils/clipboard';

interface CardState {
	abort: AbortController;
	context: PicoCardContext;
	element: HTMLElement;
	errorListener: (event: Event) => void;
	expandButton: HTMLButtonElement;
	expanded: boolean;
	expandMode: 'none' | 'fullscreen' | 'popover' | 'css';
	generation: number;
	handle?: PicoCardHandle;
	host: HTMLElement;
	kind: PicoCardKind;
	listener: (event: MouseEvent) => void;
	pendingContext?: PicoCardContext;
	preview: HTMLElement;
	ready: boolean;
	renderedContext?: PicoCardContext;
	showSource: boolean;
	source: string;
	sourceButton: HTMLButtonElement;
	sourceView: HTMLElement;
	status: HTMLElement;
	updating: boolean;
}

let nextCardId = 0;

export class PicoCardController {
	private cards = new Map<HTMLElement, CardState>();
	private container: HTMLElement | null = null;
	private destroyed = false;
	private eventDocument: Document | null = null;
	private generation = 0;
	private handleFullscreenChange = (): void => {
		for (const state of this.cards.values()) {
			if (
				state.expandMode === 'fullscreen' &&
				this.eventDocument?.fullscreenElement !== state.element
			) {
				this.closeExpanded(state);
			}
		}
	};
	private handleKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape') return;

		for (const state of this.cards.values()) {
			if (state.expanded) this.closeExpanded(state);
		}
	};
	private observer: ResizeObserver | null = null;

	private options: PicoCardSyncOptions = { dark: false };

	private renderers: PicoCardRegistry;

	constructor(renderers: PicoCardRegistry) {
		this.renderers = renderers;
	}

	destroy(): void {
		this.destroyed = true;

		for (const state of this.cards.values()) this.disposeState(state);

		this.cards.clear();
		this.observer?.disconnect();
		this.eventDocument?.removeEventListener('fullscreenchange', this.handleFullscreenChange);
		this.eventDocument?.removeEventListener('keydown', this.handleKeydown);
		this.eventDocument = null;
		this.container = null;
	}

	sync(container: HTMLElement, options: PicoCardSyncOptions): void {
		if (this.destroyed) return;

		this.container = container;
		this.options = options;
		this.observe(container);

		const elements = new Set(container.querySelectorAll<HTMLElement>(PICO_CARD_SELECTOR));

		for (const [element, state] of this.cards) {
			if (!elements.has(element) || !element.isConnected) {
				this.disposeState(state);
				this.cards.delete(element);
			}
		}

		for (const element of elements) {
			const kind = element.getAttribute(PICO_CARD_KIND_ATTR) as PicoCardKind;
			const source = element.getAttribute(PICO_CARD_SOURCE_ATTR);

			if (source === null || !['vega-lite', 'html-preview', 'openui'].includes(kind)) continue;

			let state = this.cards.get(element);

			if (state && (state.source !== source || state.kind !== kind)) {
				this.disposeState(state);
				this.cards.delete(element);
				state = undefined;
			}

			if (!state) {
				state = this.createState(element, kind, source);

				if (!state) continue;

				this.cards.set(element, state);
				this.observer?.observe(element);
				void this.renderState(state);
			} else {
				this.refreshContext(state);
			}
		}
	}

	private closeExpanded(state: CardState): void {
		if (
			state.expandMode === 'fullscreen' &&
			this.eventDocument?.fullscreenElement === state.element
		) {
			void this.eventDocument.exitFullscreen().catch(() => {});
		}

		if (state.expandMode === 'popover') {
			if (state.element.matches(':popover-open')) state.element.hidePopover();

			state.element.removeAttribute('popover');
		}

		state.expanded = false;
		state.expandMode = 'none';
		state.element.classList.remove('pico-card-expanded');
		state.expandButton.textContent = 'Expand';
		state.expandButton.setAttribute('aria-expanded', 'false');
		state.expandButton.setAttribute('aria-label', 'Expand');
	}

	private createState(
		element: HTMLElement,
		kind: PicoCardKind,
		source: string
	): CardState | undefined {
		const preview = element.querySelector<HTMLElement>('[data-pico-preview]');
		const sourceView = element.querySelector<HTMLElement>('[data-pico-source-view]');
		const status = element.querySelector<HTMLElement>('[data-pico-status]');
		const actions = element.querySelector<HTMLElement>('.pico-card-actions');

		if (!preview || !sourceView || !status || !actions) return;

		// The allowHtml path sanitizes authored HTML and removes all buttons. Recreate
		// these trusted controls in the DOM without expanding that HTML allowlist.
		const control = (action: string, label: string): HTMLButtonElement => {
			let button = actions.querySelector<HTMLButtonElement>(`[data-pico-action="${action}"]`);

			if (!button) {
				button = element.ownerDocument.createElement('button');
				button.type = 'button';
				button.className = 'pico-card-action';
				button.dataset.picoAction = action;
				button.textContent = label;
				button.setAttribute('aria-label', action === 'copy' ? 'Copy exact source' : label);
				actions.append(button);
			}

			return button;
		};

		control('copy', 'Copy');
		const sourceButton = control('source', 'Source');
		const expandButton = control('expand', 'Expand');

		sourceButton.setAttribute('aria-pressed', 'false');
		sourceButton.disabled = true;
		expandButton.setAttribute('aria-expanded', 'false');

		const abort = new AbortController();
		const host = element.ownerDocument.createElement('div');
		const context: PicoCardContext = {
			dark: this.options.dark,
			id: `pico-card-${++nextCardId}`,
			signal: abort.signal,
			width: element.clientWidth
		};
		const state: CardState = {
			abort,
			context,
			element,
			errorListener: (event) => {
				if (!this.isCurrent(state)) return;

				const detail = (event as CustomEvent<unknown>).detail;
				const error =
					detail && typeof detail === 'object' && 'error' in detail ? detail.error : detail;

				this.showError(state, error);
			},
			expandButton,
			expanded: false,
			expandMode: 'none',
			generation: ++this.generation,
			host,
			kind,
			listener: (event) => this.handleClick(state, event),
			preview,
			ready: false,
			showSource: false,
			source,
			sourceButton,
			sourceView,
			status,
			updating: false
		};

		context.onAction = (action) => {
			if (this.isCurrent(state)) this.options.onAction?.(action);
		};
		host.className = 'pico-card-render pico-card-render--pending';
		host.setAttribute('aria-busy', 'true');
		preview.hidden = false;
		sourceView.hidden = false;
		sourceButton.disabled = true;
		status.hidden = false;
		status.textContent = 'Rendering preview...';
		element.setAttribute('aria-busy', 'true');
		element.setAttribute('data-pico-id', context.id);
		element.addEventListener('click', state.listener);
		host.addEventListener('pico-card-error', state.errorListener);
		preview.appendChild(host);

		return state;
	}

	private disposeHandle(handle: PicoCardHandle): void {
		try {
			handle.dispose();
		} catch (error) {
			console.warn('Unable to dispose Pico card:', error);
		}
	}

	private disposeState(state: CardState): void {
		state.abort.abort();
		state.pendingContext = undefined;
		this.closeExpanded(state);
		state.element.removeEventListener('click', state.listener);
		state.host.removeEventListener('pico-card-error', state.errorListener);
		this.observer?.unobserve(state.element);
		state.host.remove();

		if (state.handle) this.disposeHandle(state.handle);

		state.handle = undefined;
	}

	private async handleClick(state: CardState, event: MouseEvent): Promise<void> {
		const target = event.target;

		if (!(target instanceof Element)) return;

		const button = target.closest<HTMLElement>('[data-pico-action]');

		if (!button || button.closest(PICO_CARD_SELECTOR) !== state.element) return;

		event.preventDefault();
		event.stopPropagation();

		switch (button.getAttribute('data-pico-action')) {
			case 'copy':
				await copyToClipboard(state.source);

				break;
			case 'source':
				if (!state.ready) return;

				state.showSource = !state.showSource;
				state.sourceView.hidden = !state.showSource;
				state.preview.hidden = state.showSource;
				state.sourceButton.setAttribute('aria-pressed', String(state.showSource));

				break;
			case 'expand':
				await this.toggleExpanded(state);

				break;
		}
	}

	private isCurrent(state: CardState): boolean {
		return !state.abort.signal.aborted && this.isMounted(state);
	}

	private isMounted(state: CardState): boolean {
		return (
			!this.destroyed &&
			this.cards.get(state.element) === state &&
			state.element.isConnected &&
			!!this.container?.contains(state.element)
		);
	}

	private observe(container: HTMLElement): void {
		if (!this.observer && typeof ResizeObserver !== 'undefined') {
			this.observer = new ResizeObserver((entries) => {
				for (const entry of entries) {
					const state = this.cards.get(entry.target as HTMLElement);

					if (state && this.isCurrent(state)) this.refreshContext(state);
				}
			});
		}

		if (this.eventDocument === container.ownerDocument) return;

		this.eventDocument?.removeEventListener('fullscreenchange', this.handleFullscreenChange);
		this.eventDocument?.removeEventListener('keydown', this.handleKeydown);
		this.eventDocument = container.ownerDocument;
		this.eventDocument.addEventListener('fullscreenchange', this.handleFullscreenChange);
		this.eventDocument.addEventListener('keydown', this.handleKeydown);
	}

	private refreshContext(state: CardState): void {
		const context: PicoCardContext = {
			...state.context,
			dark: this.options.dark,
			width: state.element.clientWidth
		};

		state.context = context;

		if (!state.handle?.update || !state.renderedContext) return;

		if (
			!state.updating &&
			context.dark === state.renderedContext.dark &&
			context.width === state.renderedContext.width
		)
			return;

		state.pendingContext = context;

		if (!state.updating) void this.updateState(state);
	}

	private async renderState(state: CardState): Promise<void> {
		const generation = state.generation;
		const renderer = this.renderers[state.kind];

		if (!this.isCurrent(state)) return;

		if (!renderer) {
			this.showError(state, 'This card renderer is unavailable');

			return;
		}

		const context = state.context;

		try {
			const handle = await renderer(state.host, state.source, context);

			if (!this.isCurrent(state) || state.generation !== generation) {
				this.disposeHandle(handle);

				return;
			}

			state.handle = handle;
			state.renderedContext = context;
			state.ready = true;
			state.host.classList.remove('pico-card-render--pending');
			state.host.removeAttribute('aria-busy');
			state.element.setAttribute('aria-busy', 'false');
			state.status.hidden = true;
			state.sourceView.hidden = !state.showSource;
			state.sourceButton.disabled = false;
			this.refreshContext(state);
		} catch (error) {
			if (this.isCurrent(state)) this.showError(state, error);
		}
	}

	private showError(state: CardState, error: unknown): void {
		state.abort.abort();
		state.ready = false;
		state.host.removeEventListener('pico-card-error', state.errorListener);
		state.host.remove();
		state.preview.hidden = true;
		state.sourceView.hidden = false;
		state.sourceButton.disabled = true;
		state.sourceButton.setAttribute('aria-pressed', 'true');
		state.element.setAttribute('aria-busy', 'false');
		state.status.hidden = false;
		state.status.textContent = `Preview unavailable: ${error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unable to render this card'}`;

		if (state.handle) this.disposeHandle(state.handle);

		state.handle = undefined;
	}

	private async toggleExpanded(state: CardState): Promise<void> {
		if (state.expanded) {
			this.closeExpanded(state);

			return;
		}

		state.expanded = true;
		state.element.classList.add('pico-card-expanded');
		state.expandButton.textContent = 'Close preview';
		state.expandButton.setAttribute('aria-label', 'Close preview');
		state.expandButton.setAttribute('aria-expanded', 'true');

		if (state.element.requestFullscreen && state.element.ownerDocument.fullscreenEnabled) {
			state.expandMode = 'fullscreen';

			try {
				await state.element.requestFullscreen();

				if (!this.isMounted(state) || !state.expanded) {
					if (this.eventDocument?.fullscreenElement === state.element) {
						void this.eventDocument.exitFullscreen().catch(() => {});
					}
				}

				return;
			} catch {
				// Keep the same DOM in the top layer when fullscreen is unavailable.
			}
		}

		if (!this.isMounted(state) || !state.expanded) return;

		if (state.element.showPopover) {
			state.element.setAttribute('popover', 'manual');

			try {
				state.element.showPopover();
				state.expandMode = 'popover';

				return;
			} catch {
				state.element.removeAttribute('popover');
			}
		}

		state.expandMode = 'css';
	}

	private async updateState(state: CardState): Promise<void> {
		state.updating = true;

		try {
			while (state.pendingContext && this.isCurrent(state) && state.handle?.update) {
				const context = state.pendingContext;

				state.pendingContext = undefined;

				if (
					state.renderedContext?.dark === context.dark &&
					state.renderedContext.width === context.width
				)
					continue;

				await state.handle.update(context);
				state.renderedContext = context;
			}
		} catch (error) {
			if (this.isCurrent(state)) this.showError(state, error);
		} finally {
			state.updating = false;
		}
	}
}
