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

	return DOMPurify.sanitize(source, {
		FORBID_ATTR: ['href', 'xlink:href'],
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
		USE_PROFILES: { svg: true, svgFilters: true }
	}) as string;
}
