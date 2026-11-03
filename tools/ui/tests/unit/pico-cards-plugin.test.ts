import { rehypeEnhanceCodeBlocks } from '$lib/components/app/content/MarkdownContent/plugins/rehype/enhance-code-blocks';
import { rehypePicoCards } from '$lib/pico-cards/plugin';
import { PICO_CARD_KIND_ATTR, PICO_CARD_SOURCE_ATTR } from '$lib/pico-cards/types';
import type { Element, Root } from 'hast';
import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';

async function transform(markdown: string) {
	const processor = remark()
		.use(remarkRehype)
		.use(rehypePicoCards)
		.use(rehypeEnhanceCodeBlocks)
		.use(rehypeStringify);
	const tree = await processor.run(processor.parse(markdown));

	return { html: processor.stringify(tree), tree: tree as Root };
}

function cards(tree: Root): Element[] {
	const found: Element[] = [];

	visit(tree, 'element', (node) => {
		if (node.properties[PICO_CARD_KIND_ATTR]) found.push(node);
	});

	return found;
}

describe('Pico card fence adapter', () => {
	it.each(['vega-lite', 'html-preview', 'openui'])(
		'claims %s without nesting the generic code-block chrome',
		async (kind) => {
			const { html, tree } = await transform(`\`\`\`${kind}\nexample\n\`\`\``);

			expect(cards(tree)).toHaveLength(1);
			expect(cards(tree)[0].properties[PICO_CARD_KIND_ATTR]).toBe(kind);
			expect(html).toContain('data-pico-source-view');
			expect(html).not.toContain('class="code-block-wrapper');
		}
	);

	it('keeps exact authored whitespace and isolates markup as source', async () => {
		const source = '  <script data-test="value">bad & worse</script>  \n\n  last line  ';
		const { html, tree } = await transform(`\`\`\`html-preview\n${source}\n\`\`\``);

		expect(cards(tree)[0].properties[PICO_CARD_SOURCE_ATTR]).toBe(source);
		expect(html).toContain('&#x3C;script');
		expect(html).toContain('data-test=&#x22;value&#x22;');
		expect(html).not.toContain('hidden');
	});

	it('leaves unknown fence languages to the existing code renderer', async () => {
		const { html, tree } = await transform('```json\n{"value": 1}\n```');

		expect(cards(tree)).toHaveLength(0);
		expect(html).toContain('code-block-wrapper');
	});

	it('retains separate occurrences of repeated identical cards', async () => {
		const fence = '```openui\nroot = Text("Hello")\n```';
		const { tree } = await transform(`${fence}\n\n${fence}`);

		expect(cards(tree)).toHaveLength(2);
		expect(cards(tree)[0]).not.toBe(cards(tree)[1]);
	});
});
