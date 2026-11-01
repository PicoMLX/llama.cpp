import { renderHtmlPreview } from '$lib/pico-cards/renderers/html';
import type { PicoCardContext, PicoCardHandle } from '$lib/pico-cards/types';
import { afterEach, describe, expect, it } from 'vitest';

const hosts: HTMLElement[] = [];
const handles: PicoCardHandle[] = [];

function fixture(): { context: PicoCardContext; host: HTMLElement } {
	const host = document.createElement('div');

	host.style.width = '600px';
	document.body.append(host);
	hosts.push(host);

	return {
		context: {
			dark: false,
			id: crypto.randomUUID(),
			signal: new AbortController().signal,
			width: 600
		},
		host
	};
}

afterEach(() => {
	for (const handle of handles.splice(0)) handle.dispose();
	for (const host of hosts.splice(0)) host.remove();
});

describe('static HTML cards', () => {
	it('renders with an opaque CSP frame when randomUUID is unavailable on LAN HTTP', async () => {
		const { context, host } = fixture();
		const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');

		Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });

		try {
			const handle = await renderHtmlPreview(host, '<p>LAN HTTP preview</p>', context);

			handles.push(handle);
			const frame = host.querySelector('iframe')!;
			const markup = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
			const nonce = markup.querySelector('script')?.getAttribute('nonce');

			expect(frame.title).toContain('LAN HTTP preview');
			expect(parseInt(frame.style.height)).toBeGreaterThan(1);
			expect(frame.sandbox.contains('allow-scripts')).toBe(true);
			expect(frame.sandbox.contains('allow-same-origin')).toBe(false);
			expect(frame.contentDocument).toBeNull();
			expect(nonce).toMatch(/^[a-f0-9]{32}$/);
			expect(
				markup.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')
			).toContain(`script-src 'nonce-${nonce}'`);
		} finally {
			if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
			else Reflect.deleteProperty(crypto, 'randomUUID');
		}
	});

	it('renders a styled preview and preserves its frame on theme changes', async () => {
		const { context, host } = fixture();
		const handle = await renderHtmlPreview(
			host,
			'<style>.card{padding:24px;background:linear-gradient(red,blue)}</style><section class="card"><h2>Preview title</h2><p>Static content</p></section>',
			context
		);

		handles.push(handle);
		const frame = host.querySelector('iframe')!;

		expect(frame.title).toContain('Preview title');
		expect(parseInt(frame.style.height)).toBeGreaterThan(60);
		await handle.update?.({ ...context, dark: true, width: 400 });
		expect(host.querySelector('iframe')).toBe(frame);
		expect(frame.sandbox.contains('allow-same-origin')).toBe(false);
	});

	it('includes authored body margins in the preview height', async () => {
		const { context, host } = fixture();
		const handle = await renderHtmlPreview(
			host,
			'<body style="margin:32px"><p style="margin:0;height:24px">Body margins</p></body>',
			context
		);

		handles.push(handle);
		const frame = host.querySelector('iframe')!;

		expect(frame.title).toContain('Body margins');
		expect(parseInt(frame.style.height)).toBe(88);
	});

	it('removes active content, navigation, forms and external images', async () => {
		const { context, host } = fixture();
		const handle = await renderHtmlPreview(
			host,
			'<p>Kept</p><img src="https://invalid.example/image.png" alt="A diagram"><script>parent.postMessage({type:"evil"},"*")</script><form><input value="Secret"><button>Submit</button></form><iframe src="https://invalid.example/"></iframe>',
			context
		);

		handles.push(handle);
		const frame = host.querySelector('iframe')!;

		expect(frame.title).toContain('Kept');
		expect(frame.title).toContain('[Image: A diagram]');
		expect(frame.title).not.toContain('Secret');
		expect(frame.title).not.toContain('Submit');
		expect(frame.srcdoc).toContain("default-src 'none'");
	});

	it.each([
		'<!ENTITY payload "boom"><p>Text</p>',
		'x'.repeat(131073),
		'<div style="position:fixed">Viewport fixed</div>'
	])('rejects unsupported content for source fallback', async (source) => {
		const { context, host } = fixture();

		await expect(renderHtmlPreview(host, source, context)).rejects.toBeInstanceOf(Error);
		expect(host.querySelector('iframe')).toBeNull();
	});

	it('rejects cancellation and removes its frame', async () => {
		const { context, host } = fixture();
		const abort = new AbortController();
		const pending = renderHtmlPreview(host, '<p>Cancelled</p>', {
			...context,
			signal: abort.signal
		});

		abort.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(host.querySelector('iframe')).toBeNull();
	});
});
