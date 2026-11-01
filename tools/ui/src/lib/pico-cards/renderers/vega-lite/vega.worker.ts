import { prepareVegaExpressions } from './expressions';
import { MAX_VEGA_SVG_BYTES, parseVegaLiteSpec, type VegaSpec } from './policy';
import type { VegaRenderRequest, VegaRenderResponse } from './worker-client';
import * as vega from 'vega';
import { expressionInterpreter } from 'vega-interpreter';
import { compile, type TopLevelSpec } from 'vega-lite';

const scope = globalThis as unknown as {
	onmessage: ((event: MessageEvent<VegaRenderRequest>) => Promise<void>) | null;
	postMessage(value: VegaRenderResponse): void;
};
const blocked = () => Promise.reject(new Error('External chart resources are disabled'));
const loader = { file: blocked, http: blocked, load: blocked, sanitize: blocked };

// This module only runs in a dedicated worker; the app's globals remain intact.
Object.defineProperty(globalThis, 'Function', {
	value: () => {
		throw new Error('Dynamic code generation is disabled');
	}
});
Object.defineProperty(globalThis, 'eval', {
	value: () => {
		throw new Error('Dynamic code generation is disabled');
	}
});
Object.defineProperty(globalThis, 'fetch', { value: blocked });

interface TextItem {
	font?: string;
	fontSize?: number;
	fontStyle?: string;
	fontWeight?: string | number;
	text?: unknown;
}
const textContext =
	typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') : null;

if (textContext) {
	const widths = new Map<string, number>();

	(
		vega as unknown as { textMetrics: { width(item: TextItem, text?: unknown): number } }
	).textMetrics.width = (item, text) => {
		const value = String(text ?? item.text ?? '').trim();
		const size = item.fontSize ?? 11;
		const font = `${item.fontStyle ?? 'normal'} ${item.fontWeight ?? 'normal'} ${size}px ${item.font ?? 'sans-serif'}`;
		const key = `${font}:${value}`;
		const cached = widths.get(key);

		if (cached !== undefined) return cached;

		textContext.font = font;
		const width = textContext.measureText(value).width;

		if (widths.size >= 4_096) widths.clear();

		widths.set(key, width);

		return width;
	};
}

interface ScaleParameters {
	schemeCount?: number;
	bins?: number[] | { start?: number; stop?: number; step?: number };
	domain?: number[];
}
const scalePrototype = (
	vega.transforms.scale as unknown as {
		prototype: { transform(params: ScaleParameters, pulse: unknown): unknown };
	}
).prototype;
const scaleTransform = scalePrototype.transform;

let allocationRejected = false;

scalePrototype.transform = function (params, pulse) {
	const bins = params.bins;

	let safe =
		params.schemeCount == null ||
		(Number.isFinite(params.schemeCount) && params.schemeCount > 0 && params.schemeCount <= 256);

	if (bins) {
		if (Array.isArray(bins)) safe &&= bins.length <= 258;
		else {
			const domain = params.domain ?? [];
			const start = bins.start ?? domain[0];
			const stop = bins.stop ?? domain[domain.length - 1];
			const step = bins.step;

			safe &&=
				[start, stop, step].every((value) => typeof value === 'number' && Number.isFinite(value)) &&
				typeof step === 'number' &&
				step > 0 &&
				Math.abs((stop - start) / step) <= 257;
		}
	}

	if (!safe) {
		allocationRejected = true;

		throw new Error('Chart allocation limit');
	}

	return scaleTransform.call(this, params, pulse);
};

let stringBudget = 0;
let expressionRejected = false;

vega.expressionFunction('picoBoundedExpression', (value: unknown) => {
	if (typeof value === 'string') {
		stringBudget += value.length;

		if (value.length > 8_192 || stringBudget > 8_388_608) {
			expressionRejected = true;

			throw new Error('Expression result limit');
		}
	} else if (
		typeof value === 'function' ||
		typeof value === 'symbol' ||
		(value != null && typeof value === 'object' && !(value instanceof Date))
	) {
		expressionRejected = true;

		throw new Error('Expression result must be scalar');
	}

	return value;
});

function fitSizes(value: unknown, width: number): void {
	if (!value || typeof value !== 'object') return;

	if (Array.isArray(value)) {
		value.forEach((child) => fitSizes(child, width));

		return;
	}

	const spec = value as VegaSpec;

	if (spec.width === 'container') spec.width = width;

	if (spec.height === 'container') spec.height = 300;

	for (const [key, child] of Object.entries(spec)) {
		if (key !== 'values' && key !== 'datasets') fitSizes(child, width);
	}
}

scope.onmessage = async ({ data }) => {
	let view: vega.View | undefined;

	try {
		const spec = parseVegaLiteSpec(data.source);

		prepareVegaExpressions(spec, vega.parseExpression);
		const width = Math.min(2_048, Math.max(64, Math.round(data.width / 8) * 8));

		if (!Number.isFinite(width)) throw new Error('Invalid chart width');

		fitSizes(spec, width);

		if (!spec.facet && !spec.repeat && !spec.hconcat && !spec.vconcat && !spec.concat) {
			spec.width = Math.min(typeof spec.width === 'number' ? spec.width : width, width);
			spec.autosize = { contains: 'padding', resize: false, type: 'fit' };
		}

		const foreground = data.dark ? '#e5e7eb' : '#171717';
		const grid = data.dark ? '#404040' : '#d4d4d4';
		const markColor = data.dark ? '#3987e5' : '#2a78d6';
		const compiled = compile(spec as unknown as TopLevelSpec, {
			config: {
				axis: {
					domainColor: grid,
					gridColor: grid,
					labelColor: foreground,
					labelFontSize: 12,
					tickColor: grid,
					titleColor: foreground,
					titleFontSize: 14
				},
				background: 'transparent',
				font: 'sans-serif',
				legend: {
					labelColor: foreground,
					labelFontSize: 12,
					titleColor: foreground,
					titleFontSize: 14
				},
				mark: { color: markColor },
				text: { color: foreground, fontSize: 14 },
				title: { color: foreground, fontSize: 15 },
				view: { continuousHeight: 300, continuousWidth: 480, stroke: grid }
			},
			logger: vega.logger(vega.None)
		}).spec;
		const runtime = vega.parse(compiled, undefined, { ast: true });

		view = new vega.View(runtime, { expr: expressionInterpreter, loader, renderer: 'none' });
		view.logLevel(vega.None);
		const svg = await view.toSVG();

		if (
			allocationRejected ||
			expressionRejected ||
			new TextEncoder().encode(svg).length > MAX_VEGA_SVG_BYTES
		) {
			throw new Error('Chart output limit');
		}

		scope.postMessage({ svg });
	} catch {
		// Diagnostics may quote private chart data; report only the failure state.
		scope.postMessage({ error: true });
	} finally {
		view?.finalize();
	}
};
