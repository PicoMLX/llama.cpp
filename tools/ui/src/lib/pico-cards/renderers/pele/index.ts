import { base } from '$app/paths';

export interface PeleFallbackOptions {
	maxWidth?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface PeleWorkerResponse {
	ok?: boolean;
	svg?: string;
	message?: string;
}

let nextRenderId = 0;

export function isPeleFallbackDiagram(source: string): boolean {
	const body = source
		.replace(/\r\n?/g, '\n')
		.replace(/^\uFEFF/, '')
		.trimStart()
		.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
		.replace(/^(?:\s|%%[^\n]*(?:\n|$))*/, '');

	return /^(?:usecase|agentflow)-beta(?:\s|$)/i.test(body);
}

export async function renderPeleFallback(
	source: string,
	dark: boolean,
	{ maxWidth = 640, signal, timeoutMs = 5_000 }: PeleFallbackOptions = {}
): Promise<string> {
	if (!isPeleFallbackDiagram(source)) throw new Error('Diagram is handled by Mermaid.js');

	source = source.replace(/\r\n?/g, '\n');

	if (new TextEncoder().encode(source).length > 32_768 || source.split('\n').length > 1_024) {
		throw new Error('Pele diagram source exceeds the native size limits');
	}

	if (signal?.aborted) throw new DOMException('Diagram rendering cancelled', 'AbortError');

	if (
		!Number.isFinite(maxWidth) ||
		maxWidth <= 0 ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		throw new Error('Invalid diagram rendering limits');
	}

	const worker = new Worker(`${base}/pico-runtime/pele/pele.worker.js`);

	return new Promise((resolve, reject) => {
		let settled = false;

		const finish = (error?: Error, svg?: string) => {
			if (settled) return;

			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			worker.terminate();

			if (error) reject(error);
			else resolve(svg!);
		};
		const abort = () => finish(new DOMException('Diagram rendering cancelled', 'AbortError'));
		const timeout = setTimeout(
			() => finish(new Error('Pele diagram rendering timed out')),
			timeoutMs
		);

		signal?.addEventListener('abort', abort, { once: true });
		worker.onmessage = (event: MessageEvent<PeleWorkerResponse>) => {
			const result = event.data;

			if (result?.ok && typeof result.svg === 'string' && result.svg.startsWith('<svg')) {
				finish(undefined, result.svg);
			} else {
				finish(new Error(result?.message || 'Pele diagram could not be rendered'));
			}
		};
		worker.onerror = (event) => {
			event.preventDefault();
			finish(new Error('Pele diagram worker is unavailable'));
		};
		worker.onmessageerror = () => finish(new Error('Pele diagram worker returned invalid data'));

		try {
			worker.postMessage({
				dark,
				idPrefix: `pico-pele-${++nextRenderId}`,
				maxWidth: Math.min(2_048, maxWidth),
				source
			});
		} catch {
			finish(new Error('Pele diagram worker could not start'));
		}
	});
}
