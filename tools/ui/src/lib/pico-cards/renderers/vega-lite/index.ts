import type { PicoCardContext, PicoCardHandle } from '../../types';
import { parseVegaLiteSpec } from './policy';
import { sanitizeVegaSvg } from './svg';
import VegaWorker from './vega.worker?worker';
import { renderInVegaWorker } from './worker-client';
import { mountSvgShadow } from '$lib/utils/svg-shadow';

const chartStyle =
	':host{display:block;max-width:100%;overflow:auto}svg{display:block;max-width:100%;height:auto}';

export async function renderVegaLite(
	host: HTMLElement,
	source: string,
	context: PicoCardContext
): Promise<PicoCardHandle> {
	const spec = parseVegaLiteSpec(source);
	const title =
		typeof spec.title === 'string'
			? spec.title
			: spec.title &&
				  typeof spec.title === 'object' &&
				  'text' in spec.title &&
				  typeof spec.title.text === 'string'
				? spec.title.text
				: typeof spec.description === 'string'
					? spec.description
					: 'Vega-Lite chart';

	let disposed = false;
	let revision = 0;
	let active: AbortController | undefined;
	let detach = () => {};
	let renderedKey = '';

	async function render(next: PicoCardContext): Promise<void> {
		if (disposed) return;

		if (!Number.isFinite(next.width) || next.width <= 0) throw new Error('Invalid chart width');

		const width = Math.min(2_048, Math.max(64, Math.round(next.width / 8) * 8));
		const key = `${width}:${next.dark}`;

		if (key === renderedKey) return;

		const current = ++revision;

		active?.abort();
		detach();
		const controller = new AbortController();

		active = controller;
		const abort = () => controller.abort();

		detach = () => next.signal.removeEventListener('abort', abort);
		next.signal.addEventListener('abort', abort, { once: true });

		if (next.signal.aborted) controller.abort();

		try {
			const svg = await renderInVegaWorker(
				() => new VegaWorker(),
				{ dark: next.dark, source, width },
				controller.signal
			);

			if (disposed || current !== revision || controller.signal.aborted) return;

			const clean = sanitizeVegaSvg(svg);

			if (!clean) throw new Error('Chart output unavailable');

			const svgDocument = new DOMParser().parseFromString(clean, 'image/svg+xml');
			const root = svgDocument.documentElement;
			const outputWidth = Number(root.getAttribute('width'));
			const outputHeight = Number(root.getAttribute('height'));

			if (
				root.localName !== 'svg' ||
				!Number.isFinite(outputWidth) ||
				!Number.isFinite(outputHeight) ||
				outputWidth <= 0 ||
				outputHeight <= 0 ||
				outputWidth > 4_096 ||
				outputHeight > 4_096 ||
				outputWidth * outputHeight > 8_388_608
			)
				throw new Error('Chart output dimensions unsupported');

			const mount = document.createElement('div');

			mount.setAttribute('role', 'img');
			mount.setAttribute('aria-label', title);
			mountSvgShadow(mount, clean, chartStyle);
			host.replaceChildren(mount);
			renderedKey = key;
		} catch (error) {
			if (disposed || current !== revision) return;

			throw error;
		} finally {
			if (current === revision) detach();
		}
	}

	try {
		await render(context);
	} catch (error) {
		disposed = true;
		active?.abort();
		detach();

		throw error;
	}

	return {
		dispose() {
			disposed = true;
			revision++;
			active?.abort();
			detach();
			host.replaceChildren();
		},
		update: render
	};
}
