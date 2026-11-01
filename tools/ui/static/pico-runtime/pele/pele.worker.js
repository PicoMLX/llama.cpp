importScripts('./pele-bundle.js');

const measureContext = typeof OffscreenCanvas === 'function'
	? new OffscreenCanvas(1, 1).getContext('2d')
	: null;

if (measureContext) {
	self.peleMeasureText = (text, size, style, family, monoFamily) => {
		const effectiveSize = style & (8 | 16) ? size / 1.2 : size;

		measureContext.font = `${style & 2 ? 'italic ' : ''}${style & 1 ? 'bold ' : ''}${effectiveSize}px ${style & 4 ? monoFamily : family}`;

		return measureContext.measureText(text).width;
	};
}

self.onmessage = ({ data }) => {
	try {
		const { dark, idPrefix, maxWidth, source } = data;
		const result = self.renderDiagram(source, {
			fontFamily: 'sans-serif',
			fontFamilyMono: 'monospace',
			fontSize: 14,
			idPrefix,
			maxWidth,
			theme: {
				accent: dark ? '#60a5fa' : '#2563eb',
				bg: dark ? '#111111' : '#ffffff',
				border: dark ? '#525252' : '#d4d4d4',
				fg: dark ? '#fafafa' : '#171717',
				font: 'sans-serif',
				'font-mono': 'monospace',
				line: dark ? '#d4d4d4' : '#404040',
				muted: dark ? '#a3a3a3' : '#737373',
				surface: dark ? '#262626' : '#f5f5f5',
				'surface-alt': dark ? '#404040' : '#e5e5e5'
			}
		});

		if (!result.ok) throw new Error(result.message || 'Pele diagram could not be rendered');

		if (!['usecase', 'agentflow'].includes(result.type) || result.svg.length > 262_144) {
			throw new Error('Pele diagram output is unsupported or too large');
		}

		self.postMessage({ ok: true, svg: result.svg });
	} catch (error) {
		self.postMessage({ message: String(error.message || error), ok: false });
	}
};
