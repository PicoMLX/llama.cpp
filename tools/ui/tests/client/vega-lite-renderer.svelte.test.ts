import bar from '../unit/fixtures/vega-lite/bar.vl.json';
import { renderVegaLite } from '$lib/pico-cards/renderers/vega-lite';
import { sanitizeVegaSvg } from '$lib/pico-cards/renderers/vega-lite/svg';
import type { PicoCardContext } from '$lib/pico-cards/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

function context(overrides: Partial<PicoCardContext> = {}): PicoCardContext {
	return {
		dark: false,
		id: 'chart-one',
		signal: new AbortController().signal,
		width: 480,
		...overrides
	};
}

function chart(host: HTMLElement) {
	return host.firstElementChild?.shadowRoot?.querySelector('svg');
}
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe('Vega-Lite completed card renderer', () => {
	it('renders the pinned upstream bars through an isolated worker and preserves authored values', async () => {
		const host = document.createElement('div');

		document.body.appendChild(host);
		const originalFunction = globalThis.Function;
		const handle = await renderVegaLite(host, JSON.stringify(bar), context());

		expect(chart(host)).not.toBeNull();
		expect(chart(host)?.querySelectorAll('[aria-roledescription="bar"]').length).toBe(9);
		expect(chart(host)?.textContent).toContain('A');
		expect(host.firstElementChild?.getAttribute('role')).toBe('img');
		expect(globalThis.Function).toBe(originalFunction);
		expect(new Function('return 2')()).toBe(2);
		handle.dispose();
		expect(host.childNodes).toHaveLength(0);
	}, 15_000);

	it('rerenders line charts for width and theme without stale output replacing the final view', async () => {
		const host = document.createElement('div');

		document.body.appendChild(host);
		const source = JSON.stringify({
			data: {
				values: [
					{ x: 1, y: 2 },
					{ x: 2, y: 4 },
					{ x: 3, y: 3 }
				]
			},
			encoding: {
				x: { field: 'x', type: 'quantitative' },
				y: { field: 'y', type: 'quantitative' }
			},
			mark: 'line',
			title: 'A line chart'
		});
		const handle = await renderVegaLite(host, source, context());

		expect(chart(host)?.querySelector('[aria-roledescription="line mark"]')).not.toBeNull();
		expect(host.firstElementChild?.getAttribute('aria-label')).toBe('A line chart');
		const narrow = handle.update?.(context({ width: 200 }));
		const dark = handle.update?.(context({ dark: true, width: 360 }));

		await Promise.all([narrow, dark]);
		expect(Number(chart(host)?.getAttribute('width'))).toBeLessThanOrEqual(360);
		expect(
			chart(host)?.querySelector('[aria-roledescription="line mark"]')?.getAttribute('stroke')
		).toBe('#3987e5');
		handle.dispose();
	}, 15_000);

	it('supports bounded author calculations through the official expression interpreter', async () => {
		const host = document.createElement('div');
		const source = JSON.stringify({
			data: { values: [{ x: 1 }, { x: 2 }] },
			encoding: {
				x: { field: 'x', type: 'quantitative' },
				y: { field: 'twice', type: 'quantitative' }
			},
			mark: 'point',
			transform: [{ as: 'twice', calculate: 'datum.x * 2' }]
		});
		const handle = await renderVegaLite(host, source, context());

		expect(chart(host)?.querySelectorAll('[aria-roledescription="point"]').length).toBe(2);
		handle.dispose();
	}, 15_000);

	it('rejects invalid or external data without starting network requests or replacing source fallback', async () => {
		const host = document.createElement('div');

		host.textContent = 'Original chart source';
		const network = vi.spyOn(globalThis, 'fetch');

		await expect(renderVegaLite(host, '{', context())).rejects.toThrow();
		await expect(
			renderVegaLite(
				host,
				JSON.stringify({ data: { url: 'https://example.com/private.csv' }, mark: 'bar' }),
				context()
			)
		).rejects.toThrow();
		expect(host.textContent).toBe('Original chart source');
		expect(network).not.toHaveBeenCalled();
	});

	it('cancels an in-flight render and does not mutate a detached occurrence', async () => {
		const host = document.createElement('div');
		const controller = new AbortController();
		const rendering = renderVegaLite(
			host,
			JSON.stringify(bar),
			context({ signal: controller.signal })
		);

		controller.abort();
		await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
		expect(host.childNodes).toHaveLength(0);
	});

	it('removes active and external SVG content while keeping vectors and accessible labels', () => {
		const clean = sanitizeVegaSvg(
			'<svg width="40" height="40"><script>alert(1)</script><image href="https://example.com/a.png"/><a href="https://example.com"><text>x</text></a><style>@import "https://example.com/a.css";</style><path d="M0,0L1,1" aria-label="Value 2"/><set attributeName="href" to="https://example.com"/></svg>'
		);

		expect(clean).not.toMatch(/https:|script|<image|<style|<set|<a\s/);
		expect(clean).toContain('aria-label="Value 2"');
		expect(clean).toContain('<path');
	});
});
