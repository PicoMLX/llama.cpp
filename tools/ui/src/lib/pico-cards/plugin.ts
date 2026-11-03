import { getPicoCardLabels, PICO_CARD_NAMES } from './labels';
import { PICO_CARD_KIND_ATTR, PICO_CARD_SOURCE_ATTR, type PicoCardKind } from './types';
import type { Element, ElementContent, Root } from 'hast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

function textContent(node: ElementContent): string {
	if (node.type === 'text') return node.value;

	if (node.type === 'element') return node.children.map(textContent).join('');

	return '';
}

function button(action: string, label: string): Element {
	return {
		children: [{ type: 'text', value: label }],
		properties: {
			'aria-label': label,
			className: ['pico-card-action'],
			'data-pico-action': action,
			type: 'button',
			...(action === 'source' ? { 'aria-pressed': 'false', disabled: true } : {}),
			...(action === 'expand' ? { 'aria-expanded': 'false' } : {})
		},
		tagName: 'button',
		type: 'element'
	};
}

export const rehypePicoCards: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, 'element', (node: Element, index, parent) => {
			if (node.tagName !== 'pre' || index === undefined || !parent) return;

			const code = node.children.find(
				(child): child is Element => child.type === 'element' && child.tagName === 'code'
			);
			const classes = code?.properties.className;
			const kind = Object.keys(PICO_CARD_NAMES).find(
				(candidate) => Array.isArray(classes) && classes.includes(`language-${candidate}`)
			) as PicoCardKind | undefined;

			if (!code || !kind) return;

			const labels = getPicoCardLabels(kind);
			// remark-rehype appends one newline to code values. Keep the authored whitespace.
			const source = code.children.map(textContent).join('').replace(/\n$/, '');
			const card: Element = {
				children: [
					{
						children: [
							{
								children: [{ type: 'text', value: PICO_CARD_NAMES[kind] }],
								properties: { className: ['pico-card-label'] },
								tagName: 'span',
								type: 'element'
							},
							{
								children: [
									button('copy', labels.copy),
									button('source', labels.showCode),
									button('expand', labels.expand)
								],
								properties: { className: ['pico-card-actions'] },
								tagName: 'div',
								type: 'element'
							}
						],
						properties: { className: ['pico-card-header'] },
						tagName: 'div',
						type: 'element'
					},
					{
						children: [{ type: 'text', value: labels.preparing }],
						properties: {
							className: ['pico-card-status'],
							'data-pico-status': true,
							role: 'status'
						},
						tagName: 'div',
						type: 'element'
					},
					{
						children: [],
						properties: { className: ['pico-card-preview'], 'data-pico-preview': true },
						tagName: 'div',
						type: 'element'
					},
					{
						children: [
							{
								children: code.children,
								properties: { className: ['hljs', 'pico-card-source-pre'] },
								tagName: 'pre',
								type: 'element'
							}
						],
						properties: { className: ['pico-card-source'], 'data-pico-source-view': true },
						tagName: 'div',
						type: 'element'
					}
				],
				properties: {
					'aria-busy': 'true',
					'aria-label': labels.preview,
					className: ['pico-card'],
					[PICO_CARD_KIND_ATTR]: kind,
					[PICO_CARD_SOURCE_ATTR]: source,
					role: 'group'
				},
				tagName: 'div',
				type: 'element'
			};

			parent.children[index] = card;
		});
	};
};
