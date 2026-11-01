import { renderHtmlPreview } from './renderers/html';
import { renderOpenUI } from './renderers/openui';
import { renderVegaLite } from './renderers/vega-lite';
import type { PicoCardRegistry } from './types';

export const picoCardRenderers: PicoCardRegistry = {
	'html-preview': renderHtmlPreview,
	openui: renderOpenUI,
	'vega-lite': renderVegaLite
};
