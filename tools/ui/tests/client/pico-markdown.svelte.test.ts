import MarkdownContent from '$lib/components/app/content/MarkdownContent/MarkdownContent.svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';

afterEach(cleanup);

describe('Pico cards in the chat Markdown pipeline', () => {
	it.each([
		'```html-preview\n<section><h2>Inline static card</h2></section>\n```',
		'<section><h2>Inline static card</h2></section>\n\nAfter HTML'
	])('renders static HTML card syntax through Markdown', async (content) => {
		render(MarkdownContent, { content });
		await expect
			.poll(
				() =>
					document.querySelector<HTMLIFrameElement>('[data-pico-card="html-preview"] iframe')?.title
			)
			.toContain('Inline static card');
	});

	it('keeps ordinary HTML fences on the existing source and manual-preview path', async () => {
		render(MarkdownContent, { content: '```html\n<h2>Ordinary source</h2>\n```' });
		await expect.poll(() => document.body.textContent).toContain('Ordinary source');
		expect(document.querySelector('[data-pico-card]')).toBeNull();
	});
	it('renders a completed Vega-Lite fence and keeps its source view', async () => {
		const source = JSON.stringify({
			data: {
				values: [
					{ category: 'A', value: 2 },
					{ category: 'B', value: 5 }
				]
			},
			encoding: {
				x: { field: 'category', type: 'nominal' },
				y: { field: 'value', type: 'quantitative' }
			},
			mark: 'bar',
			title: 'Pipeline chart'
		});

		render(MarkdownContent, { content: `Before\n\n\`\`\`vega-lite\n${source}\n\`\`\`\n\nAfter` });
		await expect
			.poll(() =>
				document
					.querySelector('[data-pico-card="vega-lite"] .pico-card-render')
					?.firstElementChild?.shadowRoot?.querySelector('svg')
			)
			.toBeTruthy();
		const card = document.querySelector<HTMLElement>('[data-pico-card="vega-lite"]')!;

		expect(card.textContent).toContain('Vega-Lite');
		const sourceButton = card.querySelector<HTMLButtonElement>('[data-pico-action="source"]')!;

		sourceButton.click();
		expect(
			card.querySelector('[data-pico-source-view]')?.textContent ?? card.textContent
		).toContain(source);
		expect(document.body.textContent).toContain('Before');
		expect(document.body.textContent).toContain('After');
	}, 15000);

	it('keeps an unfinished chart fence as readable streaming code', async () => {
		render(MarkdownContent, { content: '```vega-lite\n{"mark":"bar"' });
		await expect.poll(() => document.body.textContent).toContain('"mark"');
		expect(document.querySelector('[data-pico-card]')).toBeNull();
	});

	it('falls back to readable code for a rejected chart', async () => {
		render(MarkdownContent, {
			content:
				'```vega-lite\n{"data":{"url":"https://invalid.example/data.json"},"mark":"bar"}\n```'
		});
		await expect
			.poll(() => document.querySelector('[data-pico-status]')?.textContent)
			.toMatch(/unavailable|external|inline|support|resource/i);
		expect(document.querySelector('[data-pico-card]')?.textContent).toContain('invalid.example');
	});
});
