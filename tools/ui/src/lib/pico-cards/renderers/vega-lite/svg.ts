import { MAX_VEGA_SVG_BYTES } from './policy';
import DOMPurify from 'dompurify';

/** Charts use local vector primitives, never external images, links, styles or active SVG. */
export function sanitizeVegaSvg(source: string): string {
	if (
		source.length > MAX_VEGA_SVG_BYTES ||
		new TextEncoder().encode(source).length > MAX_VEGA_SVG_BYTES ||
		!source.trimStart().startsWith('<svg')
	)
		return '';

	const clean = DOMPurify.sanitize(source, {
		FORBID_ATTR: ['href', 'xlink:href', 'style', 'xml:base'],
		FORBID_TAGS: [
			'foreignObject',
			'script',
			'style',
			'a',
			'image',
			'animate',
			'set',
			'animateMotion',
			'animateTransform'
		],
		RETURN_DOM: true,
		USE_PROFILES: { svg: true, svgFilters: true }
	}) as HTMLElement;

	for (const element of clean.querySelectorAll('*')) {
		for (const attribute of Array.from(element.attributes)) {
			const value = attribute.value.trim();

			if (
				/\\|\/\*|\*\//.test(value) ||
				(/url\s*\(/i.test(value) && !/^url\(\s*(['"]?)#[a-z_][\w:.-]*\1\s*\)$/i.test(value))
			)
				element.removeAttributeNode(attribute);
		}
	}

	return clean.innerHTML;
}
