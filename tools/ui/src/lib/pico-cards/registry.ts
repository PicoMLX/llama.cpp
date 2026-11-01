import { renderHtmlPreview } from './renderers/html';
import { renderVegaLite } from './renderers/vega-lite';
import type { PicoCardRegistry } from './types';

export const picoCardRenderers: PicoCardRegistry = {
	'html-preview': renderHtmlPreview,
	'vega-lite': renderVegaLite
};
