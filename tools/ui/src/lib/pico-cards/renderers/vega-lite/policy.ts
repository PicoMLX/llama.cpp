/** The same bounded, offline static profile used by PicoMarkdownView. */
export const MAX_VEGA_SOURCE_BYTES = 2_097_152;
export const MAX_VEGA_SVG_BYTES = 2_097_152;

export type VegaSpec = Record<string, unknown>;

const transforms = new Set([
	'aggregate',
	'joinaggregate',
	'bin',
	'timeUnit',
	'filter',
	'calculate',
	'window',
	'fold',
	'stack',
	'sample'
]);
const forbidden = new Set([
	'url',
	'href',
	'expr',
	'signal',
	'labelExpr',
	'bind',
	'select',
	'sequence',
	'density',
	'loess',
	'regression',
	'graticule',
	'sphere',
	'lookup',
	'impute',
	'pivot',
	'flatten',
	'projection',
	'__proto__',
	'constructor',
	'prototype'
]);

function object(value: unknown): value is VegaSpec {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function predicate(value: unknown, depth = 0): boolean {
	if (depth > 32) return false;

	if (typeof value === 'string')
		return value.length > 0 && new TextEncoder().encode(value).length <= 8_192;

	if (!object(value) || Object.keys(value).length === 0) return false;

	for (const key of ['and', 'or']) {
		if (
			value[key] !== undefined &&
			(!Array.isArray(value[key]) ||
				value[key].length === 0 ||
				!value[key].every((child) => predicate(child, depth + 1)))
		)
			return false;
	}

	if (value.not !== undefined && !predicate(value.not, depth + 1)) return false;

	return (
		typeof value.field === 'string' ||
		typeof value.param === 'string' ||
		value.and !== undefined ||
		value.or !== undefined ||
		value.not !== undefined
	);
}

/** Returns a fresh JSON object, never an executable expression or resource URL. */
export function parseVegaLiteSpec(source: string): VegaSpec {
	const encoder = new TextEncoder();
	const bytes = (value: string) => encoder.encode(value).length;

	if (!source || source.length > MAX_VEGA_SOURCE_BYTES || bytes(source) > MAX_VEGA_SOURCE_BYTES)
		throw new Error('Chart source limit');

	let root: unknown;

	try {
		root = JSON.parse(source);
	} catch {
		throw new Error('Invalid Vega-Lite JSON');
	}

	if (
		!object(root) ||
		!['mark', 'layer', 'facet', 'repeat', 'hconcat', 'vconcat', 'concat'].some(
			(key) => root[key] !== undefined
		)
	)
		throw new Error('Expected a Vega-Lite chart');

	let nodes = 0;
	let tuples = 0;
	let compositions = 1;
	let expansion = 1;
	let faceted = false;
	let textLines = 1;
	let longestString = 0;
	let hasLineBreak = false;
	let hasCalculate = false;

	const reject = () => {
		throw new Error('Unsupported or oversized static chart');
	};
	const multiply = (count: number) => {
		if (count <= 0 || compositions > 32 / count) reject();

		compositions *= count;
	};

	function visit(
		value: unknown,
		depth: number,
		dataValue = false,
		dataDefinition = false,
		dataRows = false
	): void {
		if (++nodes > 400_000 || depth > 32) reject();

		if (typeof value === 'string') {
			if (bytes(value) > 8_192) reject();

			longestString = Math.max(longestString, value.length);

			return;
		}

		if (typeof value === 'number') {
			if (!Number.isFinite(value) || Math.abs(value) > 1e12) reject();

			return;
		}

		if (value === null || typeof value === 'boolean') return;

		if (Array.isArray(value)) {
			if (value.length > 4_096) reject();

			if (dataValue && !dataRows) textLines = Math.max(textLines, value.length);

			value.forEach((child) => visit(child, depth + 1, dataValue));

			return;
		}

		if (!object(value)) return reject();

		if (!dataValue) {
			if (Object.keys(value).some((key) => forbidden.has(key))) reject();

			for (const key of ['text', 'value', 'datum']) {
				if (Array.isArray(value[key])) textLines = Math.max(textLines, value[key].length);
			}

			if (value.lineBreak !== undefined) {
				if (typeof value.lineBreak !== 'string') reject();

				hasLineBreak ||= Boolean(value.lineBreak);
			}

			if (value.op === 'values' || value.aggregate === 'values') reject();

			faceted ||= value.facet !== undefined;
			const mark = object(value.mark) ? value.mark.type : value.mark;

			if (
				['image', 'geoshape'].includes(String(mark)) ||
				['image', 'geoshape'].includes(String(value.type))
			)
				reject();

			for (const key of ['width', 'height']) {
				const size = value[key];

				if (typeof size === 'number' && (size < 1 || size > 2_048)) reject();

				if (typeof size === 'string' && size !== 'container') reject();
			}

			if (typeof value.step === 'number' && (value.step < 1 || value.step > 2_048)) reject();

			for (const [key, item] of Object.entries(value)) {
				const lower = key.toLowerCase();

				if (
					(lower.endsWith('fontsize') || lower.endsWith('lineheight')) &&
					(typeof item !== 'number' || item < 1 || item > 256)
				)
					reject();

				if (
					['padding', 'offset', 'titlePadding', 'labelPadding', 'tickSize', 'spacing'].includes(
						key
					) &&
					typeof item === 'number' &&
					Math.abs(item) > 256
				)
					reject();

				if (
					key === 'format' &&
					typeof item === 'string' &&
					(bytes(item) > 128 || /[0-9]{4,}/.test(item))
				)
					reject();
			}
			for (const [key, max] of [
				['tickCount', 100],
				['count', 256],
				['maxbins', 256]
			] as const) {
				if (
					value[key] !== undefined &&
					(typeof value[key] !== 'number' || value[key] < 1 || value[key] > max)
				)
					reject();
			}

			if (
				value.bins !== undefined &&
				(!Array.isArray(value.bins) ||
					value.bins.length > 256 ||
					!value.bins.every((item) => typeof item === 'number'))
			)
				reject();

			if (value.bin !== undefined) {
				if (object(value.bin)) {
					if (Object.keys(value.bin).some((key) => key !== 'maxbins')) reject();
				} else if (value.bin !== 'binned' && typeof value.bin !== 'boolean') reject();
			}

			if (
				value.data !== undefined &&
				(!object(value.data) ||
					(!Array.isArray(value.data.values) && typeof value.data.name !== 'string'))
			)
				reject();

			if (value.calculate !== undefined) {
				hasCalculate = true;

				if (
					typeof value.calculate !== 'string' ||
					!value.calculate ||
					bytes(value.calculate) > 8_192
				)
					reject();
			}

			for (const key of ['filter', 'test']) {
				if (value[key] !== undefined && !predicate(value[key])) reject();
			}

			if (Array.isArray(value.fold)) {
				if (value.fold.length === 0 || value.fold.length > 32 || expansion > 32 / value.fold.length)
					reject();

				expansion *= value.fold.length;
			}

			if (
				value.transform !== undefined &&
				(!Array.isArray(value.transform) ||
					value.transform.length > 32 ||
					!value.transform.every(
						(item) => object(item) && Object.keys(item).some((key) => transforms.has(key))
					))
			)
				reject();

			for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
				if (Array.isArray(value[key])) {
					if (value[key].length === 0 || value[key].length > 16) reject();

					multiply(value[key].length);
				}
			}

			if (typeof value.repeat === 'string') {
				if (!['row', 'column', 'layer'].includes(value.repeat)) reject();
			} else if (value.repeat !== undefined) {
				let repeats = 1;

				if (Array.isArray(value.repeat)) repeats = value.repeat.length;
				else if (object(value.repeat) && Object.keys(value.repeat).length > 0) {
					for (const [key, items] of Object.entries(value.repeat)) {
						if (
							!['row', 'column', 'layer'].includes(key) ||
							!Array.isArray(items) ||
							items.length === 0 ||
							items.length > 16
						)
							return reject();

						repeats *= items.length;
					}
				} else return reject();

				if (repeats < 1 || repeats > 16) reject();

				multiply(repeats);
			}
		}

		for (const [key, child] of Object.entries(value)) {
			if (bytes(key) > 256) reject();

			if (!dataValue && key === 'datasets') {
				if (!object(child)) return reject();

				for (const rows of Object.values(child)) {
					if (!Array.isArray(rows)) return reject();

					tuples += rows.length;
					visit(rows, depth + 1, true, false, true);
				}
			} else if (!dataValue && dataDefinition && key === 'values' && Array.isArray(child)) {
				tuples += child.length;
				visit(child, depth + 1, true, false, true);
			} else visit(child, depth + 1, dataValue, !dataValue && key === 'data');
		}
	}

	visit(root, 0);
	const textExpansion = Math.max(
		textLines,
		hasLineBreak ? (hasCalculate ? 8_193 : longestString + 1) : 1
	);

	if (
		tuples > 4_096 ||
		compositions > 32 ||
		Math.max(tuples, 1) * Math.max(compositions, 1) * expansion > 20_000 / textExpansion ||
		(faceted && tuples > 128)
	)
		reject();

	return root;
}
