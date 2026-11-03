import examples from '../fixtures/pico-cards/pele-native-examples.json';
import MarkdownContent from '$lib/components/app/content/MarkdownContent/MarkdownContent.svelte';
import { isPeleFallbackDiagram } from '$lib/pico-cards/renderers/pele';
import { copyToClipboard } from '$lib/utils/clipboard';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';

vi.mock('$lib/utils/clipboard', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/utils/clipboard')>()),
	copyToClipboard: vi.fn().mockResolvedValue(true)
}));

const fallbackExamples = examples.filter(({ source }) => isPeleFallbackDiagram(source));
const renderedSvg = () => document.querySelector('.mermaid-block-wrapper pre.mermaid svg');

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe('Pele fallback in the chat Markdown pipeline', () => {
	it.each(
		fallbackExamples.map((example, index) => ({
			...example,
			language: ['mermaid', 'mmd', 'mermaidjs'][index % 3]
		}))
	)('renders $id through a $language fence', async ({ family, language, source }) => {
		render(MarkdownContent, { content: `Before\n\n\`\`\`${language}\n${source}\n\`\`\`\n\nAfter` });
		await expect.poll(renderedSvg).toBeTruthy();
		expect(renderedSvg()?.classList.contains(`pele-${family}`)).toBe(true);
		expect(renderedSvg()?.querySelector('script,foreignObject')).toBeNull();
		expect(document.body.textContent).toContain('Before');
		expect(document.body.textContent).toContain('After');
	});

	it('keeps normal Mermaid rendering alongside both fallback families', async () => {
		const content = [
			fallbackExamples[0].source,
			fallbackExamples[1].source,
			'flowchart TD\nA[Normal Mermaid] --> B[Still supported]'
		]
			.map((source) => `\`\`\`mermaid\n${source}\n\`\`\``)
			.join('\n\n');

		render(MarkdownContent, { content });
		await expect.poll(() => document.querySelectorAll('pre.mermaid svg').length).toBe(3);
		expect(document.querySelectorAll('pre.mermaid svg.pele').length).toBe(2);
		await expect
			.poll(() => document.querySelector('pre.mermaid svg:not(.pele)')?.textContent)
			.toContain('Normal Mermaid');
	});

	it('preserves source, copy, zoom and SVG download controls', async () => {
		const source = fallbackExamples[0].source;

		render(MarkdownContent, { content: `\`\`\`mermaid\n${source}\n\`\`\`` });
		await expect.poll(renderedSvg).toBeTruthy();
		const wrapper = document.querySelector<HTMLElement>('.mermaid-block-wrapper')!;
		const sourceButton = wrapper.querySelector<HTMLButtonElement>('.toggle-source-btn')!;

		sourceButton.click();
		expect(wrapper.getAttribute('data-view-mode')).toBe('source');
		expect(wrapper.querySelector('.diagram-source')?.textContent).toContain(source);
		wrapper.querySelector<HTMLButtonElement>('.copy-code-btn')!.click();
		await expect.poll(() => vi.mocked(copyToClipboard).mock.calls.length).toBe(1);
		expect(copyToClipboard).toHaveBeenCalledWith(source);
		sourceButton.click();
		wrapper.querySelector<HTMLButtonElement>('.preview-code-btn')!.click();
		await expect.poll(() => document.querySelector('[aria-label="Zoom in"]')).toBeTruthy();
		document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
		await expect
			.poll(() => document.querySelector('.mermaid-preview-zoom-label')?.textContent)
			.toBe('115%');
		const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pico-pele-test');
		const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		document.querySelector<HTMLButtonElement>('[aria-label="Download SVG"]')!.click();
		expect(download).toHaveBeenCalledOnce();
		expect(revokeUrl).toHaveBeenCalledWith('blob:pico-pele-test');
		expect(await (createUrl.mock.calls[0][0] as Blob).text()).toContain('pele-usecase');
	});

	it('keeps malformed fallback source readable and escaped', async () => {
		const source = 'usecase-beta\n"unterminated <img src=x onerror="bad()">';

		render(MarkdownContent, { content: `\`\`\`mermaid\n${source}\n\`\`\`` });
		await expect
			.poll(() => document.querySelector('.mermaid-block-wrapper')?.getAttribute('data-view-mode'))
			.toBe('source');
		expect(document.querySelector('.diagram-source')?.textContent).toContain(source);
		expect(document.querySelector('.mermaid-block-wrapper img')).toBeNull();
		expect(renderedSvg()).toBeNull();
	});

	it('waits for a closing fence before rendering a streamed fallback diagram', async () => {
		const source = fallbackExamples[0].source;
		const screen = render(MarkdownContent, { content: `\`\`\`mermaid\n${source}` });

		await expect.poll(() => document.querySelector('.streaming-mermaid-block')).toBeTruthy();
		expect(renderedSvg()).toBeNull();
		await screen.rerender({ content: `\`\`\`mermaid\n${source}\n\`\`\`` });
		await expect.poll(renderedSvg).toBeTruthy();
	});

	it('terminates a pending worker when the Markdown component is removed', async () => {
		const terminate = vi.fn();
		const postMessage = vi.fn();

		vi.stubGlobal(
			'Worker',
			class {
				postMessage = postMessage;
				terminate = terminate;
			}
		);
		const screen = render(MarkdownContent, {
			content: `\`\`\`mermaid\n${fallbackExamples[0].source}\n\`\`\``
		});

		await expect.poll(() => postMessage.mock.calls.length).toBe(1);
		await screen.unmount();
		expect(terminate).toHaveBeenCalledOnce();
		expect(renderedSvg()).toBeNull();
	});
});
