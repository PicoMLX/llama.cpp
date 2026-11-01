import examples from '../fixtures/pico-cards/pele-native-examples.json';
import { isPeleFallbackDiagram, renderPeleFallback } from '$lib/pico-cards/renderers/pele';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fallbackExamples = examples.filter(({ source }) => isPeleFallbackDiagram(source));

function svgRoot(svg: string): SVGSVGElement {
	const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

	expect(root.localName).toBe('svg');
	expect(root.querySelector('parsererror')).toBeNull();

	return root as unknown as SVGSVGElement;
}

afterEach(() => vi.unstubAllGlobals());

describe('offline Pele worker', () => {
	it.each(fallbackExamples)('renders $id ($family)', async ({ source }) => {
		const svg = await renderPeleFallback(source, false);
		const root = svgRoot(svg);

		expect(Number(root.getAttribute('width'))).toBeGreaterThan(0);
		expect(Number(root.getAttribute('height'))).toBeGreaterThan(0);
		expect(svg).not.toContain('var(');
	});

	it('uses concrete dark colors', async () => {
		const source = fallbackExamples[0].source;
		const light = await renderPeleFallback(source, false);
		const dark = await renderPeleFallback(source, true);

		expect(svgRoot(light).getAttribute('fill')).toBe('#171717');
		expect(svgRoot(dark).getAttribute('fill')).toBe('#fafafa');
		expect(dark).not.toContain('var(');
	});

	it('accepts frontmatter and comments before the diagram', async () => {
		const source = `---\ntitle: Checkout\n---\n%% Generated diagram\n${fallbackExamples[0].source}`;

		svgRoot(await renderPeleFallback(source, false));
	});

	it.each(
		['usecase', 'agentflow'].flatMap((family) =>
			[
				{ name: 'newline', prefix: '\n' },
				{ name: 'spaces', prefix: '  ' },
				{ name: 'BOM', prefix: '\uFEFF' }
			].map((prefix) => ({ family, ...prefix }))
		)
	)('renders $family with $name before titled frontmatter', async ({ family, prefix }) => {
		const fixture = fallbackExamples.find((example) => example.family === family)!;
		const source = `${prefix}---\r\ntitle: Prefix regression\r\n---\r\n${fixture.source}`;
		const root = svgRoot(await renderPeleFallback(source, false));

		expect(root.classList.contains(`pele-${family}`)).toBe(true);
	});

	it('rejects malformed diagrams without returning partial markup', async () => {
		await expect(renderPeleFallback('usecase-beta\n"unterminated', false)).rejects.toThrow();
	});

	it('cancels an in-flight render', async () => {
		const controller = new AbortController();
		const rendering = renderPeleFallback(fallbackExamples[0].source, false, {
			signal: controller.signal
		});

		controller.abort();
		await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('terminates a worker that exceeds its deadline', async () => {
		const terminate = vi.fn();
		const postMessage = vi.fn();

		vi.stubGlobal(
			'Worker',
			class {
				postMessage = postMessage;
				terminate = terminate;
			}
		);
		await expect(
			renderPeleFallback(fallbackExamples[0].source, false, { timeoutMs: 5 })
		).rejects.toThrow('timed out');
		expect(terminate).toHaveBeenCalledOnce();
	});
});

describe('native diagram capability matrix', () => {
	it('renders all 91 examples across 32 families with Mermaid plus the two-family fallback', async () => {
		const { default: mermaid } = await import('mermaid');

		mermaid.initialize({
			flowchart: { htmlLabels: true, useMaxWidth: false },
			gantt: { useMaxWidth: false },
			securityLevel: 'strict',
			sequence: { useMaxWidth: false },
			startOnLoad: false,
			theme: 'default'
		});

		const families = new Set<string>();

		let fallbackCount = 0;

		for (const [index, example] of examples.entries()) {
			if (isPeleFallbackDiagram(example.source)) {
				svgRoot(await renderPeleFallback(example.source, false));
				fallbackCount++;
			} else {
				const container = document.createElement('div');

				document.body.appendChild(container);

				try {
					const { svg } = await mermaid.render(
						`native-example-${index}`,
						example.source,
						container
					);

					expect(svg, example.id).toContain('<svg');
				} finally {
					container.remove();
				}
			}

			families.add(example.family);
		}

		expect(fallbackCount).toBe(6);
		expect(families.size).toBe(32);
	}, 30_000);
});
