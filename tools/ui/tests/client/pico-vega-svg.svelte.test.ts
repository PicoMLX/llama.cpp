import { renderVegaLite } from '$lib/pico-cards/renderers/vega-lite';
import { sanitizeVegaSvg } from '$lib/pico-cards/renderers/vega-lite/svg';
import type { PicoCardContext, PicoCardHandle } from '$lib/pico-cards/types';
import { afterEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';

const paintUrl = 'https://invalid.example/pico-vega-paint-probe.svg#paint';
const handles: PicoCardHandle[] = [];
const hosts: HTMLElement[] = [];

function parse(source: string): SVGSVGElement {
	const root = new DOMParser().parseFromString(
		sanitizeVegaSvg(source),
		'image/svg+xml'
	).documentElement;

	expect(root.localName).toBe('svg');
	expect(root.querySelector('parsererror')).toBeNull();

	return root as unknown as SVGSVGElement;
}

function escapeAttribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

async function chart(fill: string | Record<string, unknown>): Promise<SVGSVGElement> {
	const host = document.createElement('div');
	const context: PicoCardContext = {
		dark: false,
		id: 'svg-resource-review',
		signal: new AbortController().signal,
		width: 480
	};

	hosts.push(host);
	document.body.append(host);
	handles.push(
		await renderVegaLite(
			host,
			JSON.stringify({
				data: { values: [{ category: 'A', value: 3 }] },
				encoding: {
					x: { field: 'category', type: 'nominal' },
					y: { field: 'value', type: 'quantitative' }
				},
				mark: { fill, type: 'bar' }
			}),
			context
		)
	);

	const svg = host.firstElementChild?.shadowRoot?.querySelector('svg');

	expect(svg).toBeTruthy();

	return svg!;
}

afterEach(() => {
	handles.splice(0).forEach((handle) => handle.dispose());
	hosts.splice(0).forEach((host) => host.remove());
});

describe('Vega SVG resource boundary', () => {
	it.each([
		'fill',
		'stroke',
		'filter',
		'mask',
		'clip-path',
		'marker-start',
		'marker-mid',
		'marker-end',
		'cursor'
	])('removes external and disguised resource values from %s', (attribute) => {
		for (const value of [
			`url(${paintUrl})`,
			`URL(//invalid.example/pico-vega-paint-probe.svg#paint)`,
			`url('${paintUrl}')`,
			'url(data:image/svg+xml;base64,PHN2Zy8+)',
			String.raw`u\72l(${paintUrl})`,
			`u/**/rl(${paintUrl})`,
			`url/**/(${paintUrl})`,
			`url(${paintUrl}/**/)`,
			`url(#local) url(${paintUrl})`,
			'url(#local) red',
			String.raw`url(#gr\61dient)`
		]) {
			const root = parse(
				`<svg width="40" height="40"><rect ${attribute}="${escapeAttribute(value)}" width="20" height="20"/></svg>`
			);

			expect(root.querySelector('rect')?.hasAttribute(attribute), value).toBe(false);
		}
	});

	it('checks decoded attributes and removes inline styles, base URLs and active content', () => {
		const root = parse(
			`<svg width="40" height="40" xml:base="${paintUrl}"><style>rect{fill:url(${paintUrl})}</style><script>bad()</script><image href="${paintUrl}"/><animate attributeName="fill" to="url(${paintUrl})"/><rect fill="url&#40;https&#58;//invalid.example/paint&#41;" style="fill:url(${paintUrl})" onload="bad()" width="20" height="20"/></svg>`
		);

		expect(root.querySelector('style,script,image,animate')).toBeNull();
		expect(root.hasAttribute('xml:base')).toBe(false);
		expect(root.querySelector('rect')?.hasAttribute('fill')).toBe(false);
		expect(root.querySelector('rect')?.hasAttribute('style')).toBe(false);
		expect(root.querySelector('rect')?.hasAttribute('onload')).toBe(false);
	});

	it('preserves local gradients, clip references and ordinary vector attributes', () => {
		const root = parse(
			'<svg width="40" height="40"><defs><linearGradient id="gradient"><stop offset="0" stop-color="#123456"/></linearGradient><clipPath id="clip"><rect width="20" height="20"/></clipPath></defs><path fill="url(#gradient)" stroke="url(&quot;#gradient&quot;)" clip-path="url(\'#clip\')" d="M0,0L20,20" stroke-width="2" aria-label="Value 3"/></svg>'
		);
		const path = root.querySelector('path');

		expect(path?.getAttribute('fill')).toBe('url(#gradient)');
		expect(path?.getAttribute('stroke')).toBe('url("#gradient")');
		expect(path?.getAttribute('clip-path')).toBe("url('#clip')");
		expect(path?.getAttribute('aria-label')).toBe('Value 3');
		expect(path?.getAttribute('stroke-width')).toBe('2');
		expect(root.querySelector('linearGradient stop')?.getAttribute('stop-color')).toBe('#123456');
	});

	it('renders standard Vega gradients with their local paint reference intact', async () => {
		const svg = await chart({
			gradient: 'linear',
			stops: [
				{ color: '#123456', offset: 0 },
				{ color: '#abcdef', offset: 1 }
			],
			x1: 0,
			x2: 1,
			y1: 0,
			y2: 1
		});
		const fill = svg.querySelector('[aria-roledescription="bar"]')?.getAttribute('fill');
		const id = fill?.match(/^url\(#([\w-]+)\)$/)?.[1];

		expect(id).toBeTruthy();
		expect(svg.querySelector(`linearGradient[id="${id}"] stop`)?.getAttribute('stop-color')).toBe(
			'#123456'
		);
	});

	it('does not issue browser paint requests from a real chart with an external mark fill', async () => {
		const session = cdp();
		const requests: string[] = [];
		const receive = ({ request }: { request: { url: string } }) => {
			if (request.url.includes('pico-vega-paint-probe')) requests.push(request.url);
		};

		await session.send('Network.enable');
		await session.send('Network.setBlockedURLs', { urls: ['*pico-vega-paint-probe*'] });
		await session.on('Network.requestWillBeSent', receive);

		try {
			const svg = await chart(`url(${paintUrl})`);

			await new Promise((resolve) => requestAnimationFrame(resolve));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(svg.querySelector('[aria-roledescription="bar"]')?.hasAttribute('fill')).toBe(false);
			expect(requests).toEqual([]);
		} finally {
			await session.off('Network.requestWillBeSent', receive);
			await session.send('Network.setBlockedURLs', { urls: [] });
			await session.send('Network.disable');
		}
	});
});
