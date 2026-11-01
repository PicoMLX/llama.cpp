import { renderVegaLite } from './renderers/vega-lite';
import type { PicoCardRegistry } from './types';

export const picoCardRenderers: PicoCardRegistry = {
	'vega-lite': renderVegaLite
};
