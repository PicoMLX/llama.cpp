export interface VegaRenderRequest {
	source: string;
	width: number;
	dark: boolean;
}

export interface VegaRenderResponse {
	svg?: string;
	error?: boolean;
}

export interface VegaWorker {
	onmessage: ((event: MessageEvent<VegaRenderResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	postMessage(request: VegaRenderRequest): void;
	terminate(): void;
}

export const VEGA_RENDER_TIMEOUT_MS = 8_000;

/** One chart per worker: timeout, cancellation and every settled result release its runtime. */
export function renderInVegaWorker(
	createWorker: () => VegaWorker,
	request: VegaRenderRequest,
	signal: AbortSignal
): Promise<string> {
	if (signal.aborted)
		return Promise.reject(new DOMException('Chart rendering cancelled', 'AbortError'));

	return new Promise((resolve, reject) => {
		let worker: VegaWorker;

		try {
			worker = createWorker();
		} catch {
			reject(new Error('Chart worker unavailable'));

			return;
		}
		let settled = false;

		const finish = (svg?: string, error?: Error) => {
			if (settled) return;

			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			worker.onmessage = null;
			worker.onerror = null;
			worker.terminate();

			if (error) reject(error);
			else if (svg) resolve(svg);
			else reject(new Error('Chart rendering failed'));
		};
		const abort = () =>
			finish(undefined, new DOMException('Chart rendering cancelled', 'AbortError'));
		const timer = setTimeout(
			() => finish(undefined, new Error('Chart rendering timed out')),
			VEGA_RENDER_TIMEOUT_MS
		);

		signal.addEventListener('abort', abort, { once: true });
		worker.onmessage = ({ data }) =>
			finish(!data.error && typeof data.svg === 'string' ? data.svg : undefined);
		worker.onerror = () => finish(undefined, new Error('Chart worker failed'));
		try {
			worker.postMessage(request);
		} catch {
			finish(undefined, new Error('Chart worker failed'));
		}
	});
}
