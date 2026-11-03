import type { Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

export const remarkPicoHtml: Plugin<[], Root> = () => (tree) => {
	visit(tree, 'html', (node, index, parent) => {
		if (index === undefined || !parent || !['root', 'blockquote', 'listItem'].includes(parent.type))
			return;

		parent.children[index] = {
			lang: 'html-preview',
			position: node.position,
			type: 'code',
			value: node.value
		};
	});
};
