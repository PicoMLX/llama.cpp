import bar from './fixtures/vega-lite/bar.vl.json';
import {
	acceptsVegaExpression,
	prepareVegaExpressions
} from '$lib/pico-cards/renderers/vega-lite/expressions';
import { parseVegaLiteSpec } from '$lib/pico-cards/renderers/vega-lite/policy';
import { parseExpression } from 'vega';
import { describe, expect, it } from 'vitest';

const parse = (spec: unknown) => parseVegaLiteSpec(JSON.stringify(spec));

describe('Vega-Lite static profile', () => {
	it('accepts the pinned upstream bar fixture and inline named datasets', () => {
		expect(parse(bar)).toEqual(bar);
		expect(
			parse({ data: { name: 'points' }, datasets: { points: [{ x: 1 }] }, mark: 'point' }).mark
		).toBe('point');
	});

	it.each([
		{ data: { url: 'https://example.com/data.csv' }, mark: 'bar' },
		{ data: { values: [] }, mark: 'image' },
		{ data: { sequence: { start: 0, stop: 1e12 } }, mark: 'line' },
		{ data: { values: [] }, mark: 'point', params: [{ name: 'pick', select: 'point' }] },
		{ data: { values: [] }, encoding: { tooltip: { signal: 'globalThis' } }, mark: 'point' },
		{
			data: { values: [] },
			mark: 'bar',
			transform: [{ from: { data: { url: '/private' } }, lookup: 'key' }]
		},
		{ data: { values: Array.from({ length: 4_097 }, () => ({ x: 1 })) }, mark: 'bar' },
		{ layer: Array.from({ length: 17 }, () => ({ mark: 'bar' })) },
		{ data: { values: [] }, mark: { fontSize: 1e9, type: 'text' } },
		{ data: { values: [] }, encoding: { x: { bin: { step: 1e-9 }, field: 'x' } }, mark: 'bar' }
	])('rejects external, interactive or unbounded specifications %#', (spec) => {
		expect(() => parse(spec)).toThrow();
	});

	it('treats data columns named url, filter or constructor as ordinary values', () => {
		const spec = JSON.parse(
			'{"data":{"values":[{"url":"https://example.com","constructor":"a","filter":"row"}]},"mark":"bar"}'
		);

		expect(parse(spec)).toEqual(spec);
	});

	it('rejects malformed JSON and specification keys used for prototype access', () => {
		expect(() => parseVegaLiteSpec('{')).toThrow();
		expect(() => parseVegaLiteSpec('{"mark":"bar","__proto__":{}}')).toThrow();
	});

	it('bounds composed/folded text expansion before starting the runtime', () => {
		expect(() =>
			parse({
				data: { values: Array.from({ length: 128 }, () => ({ x: 1 })) },
				layer: Array.from({ length: 8 }, () => ({ mark: 'text' })),
				transform: [{ fold: Array.from({ length: 32 }, (_, index) => `x${index}`) }]
			})
		).toThrow();
	});

	it('preserves bounded author calculations and filters without treating row values as expressions', () => {
		const spec = parse({
			data: { values: [{ calculate: 'not an expression' }] },
			mark: 'point',
			transform: [{ as: 'twice', calculate: 'datum.x * 2' }, { filter: 'isValid(datum.x)' }]
		});

		prepareVegaExpressions(spec, parseExpression);
		expect(spec.transform).toEqual([
			{ as: 'twice', calculate: 'picoBoundedExpression((datum.x * 2))' },
			{ filter: 'picoBoundedExpression((isValid(datum.x)))' }
		]);
		expect(spec.data).toEqual({ values: [{ calculate: 'not an expression' }] });
	});

	it.each([
		'datum.constructor',
		'datum["__proto__"]',
		'globalThis.fetch("/private")',
		'random()',
		'datum[key]',
		'datum.x = 2',
		'/x/.test(datum.x)'
	])('rejects unsafe or nondeterministic author expressions: %s', (source) => {
		expect(acceptsVegaExpression(source, parseExpression)).toBe(false);
	});
});
