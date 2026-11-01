import MarkdownContent from '$lib/components/app/content/MarkdownContent/MarkdownContent.svelte';
import { renderHtmlPreview } from '$lib/pico-cards/renderers/html';
import type { PicoCardContext, PicoCardHandle } from '$lib/pico-cards/types';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';

const hosts: HTMLElement[] = [];
const handles: PicoCardHandle[] = [];

async function preview(source: string) {
	const host = document.createElement('div');
	const context: PicoCardContext = {
		dark: false,
		id: 'geometry',
		signal: new AbortController().signal,
		width: 600
	};

	host.style.width = '600px';
	hosts.push(host);
	document.body.append(host);
	const handle = await renderHtmlPreview(host, source, context);

	handles.push(handle);

	return { context, frame: host.querySelector('iframe')!, handle, host };
}

afterEach(() => {
	cleanup();
	for (const handle of handles.splice(0)) handle.dispose();
	for (const host of hosts.splice(0)) host.remove();
});

describe('static HTML geometry', () => {
	it('retains source for root-positioned content with no intrinsic body height', async () => {
		const source = '<div style="position:absolute;top:0;height:200px">Visible</div>';

		render(MarkdownContent, { content: `\`\`\`html-preview\n${source}\n\`\`\`` });
		await expect
			.poll(() => document.querySelector('[data-pico-status]')?.textContent)
			.toContain('layout limits');
		expect(document.querySelector('[data-pico-card] iframe')).toBeNull();
		expect(document.querySelector<HTMLElement>('[data-pico-source-view]')?.hidden).toBe(false);
		expect(document.querySelector('[data-pico-source-view]')?.textContent).toContain(source);
	});

	it('includes absolute descendant bounds plus body padding, borders and margins', async () => {
		const { frame } = await preview(
			'<body style="height:24px;margin:12px;padding:4px 6px 10px;border:3px solid"><div id="absolute" style="position:absolute;top:0;left:24px;height:200px;width:100px">Visible</div></body>'
		);

		expect(frame.title).toContain('Visible');
		expect(parseInt(frame.style.height)).toBe(225);
	});

	it('shrinks after width and theme changes without a viewport floor or resize loop', async () => {
		const { context, frame, handle, host } = await preview(
			'<style>#absolute{position:absolute;top:0;width:100px;height:100px}@media(max-width:300px){#absolute{height:220px}}</style><body style="height:24px"><div id="absolute">Responsive</div></body>'
		);

		expect(parseInt(frame.style.height)).toBe(100);
		host.style.width = '240px';
		await handle.update?.({ ...context, dark: true, width: 240 });
		await expect.poll(() => parseInt(frame.style.height)).toBe(220);
		host.style.width = '600px';
		await handle.update?.(context);
		await expect.poll(() => parseInt(frame.style.height)).toBe(100);
		expect(host.querySelector('iframe')).toBe(frame);
		let measurements = 0;

		const receive = (event: MessageEvent) => {
			if (event.source === frame.contentWindow && event.data?.type === 'size') measurements++;
		};

		window.addEventListener('message', receive);
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const settled = measurements;

			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(measurements).toBe(settled);
		} finally {
			window.removeEventListener('message', receive);
		}
	});

	it('includes ordinary in-flow generated content in the intrinsic height', async () => {
		const { frame } = await preview(
			'<style>#tail::after{content:"Tail";display:block;height:50px}</style><div id="tail" style="line-height:20px">Host</div>'
		);

		expect(parseInt(frame.style.height)).toBe(70);
	});

	it.each([
		'<style>div::after{content:"Tail";position:absolute;top:150px;height:100px;width:100px}</style><div style="height:20px">Host</div>',
		'<body style="height:20px;transform:scale(.5);transform-origin:top left"><div style="height:200px">Transformed overflow</div></body>',
		'<div style="width:2000px;height:20px">Horizontal overflow</div>',
		'<div style="position:relative;top:-30px;height:40px">Negative origin</div>',
		'<body style="height:24px"><div style="position:absolute;top:4090px;height:20px">Too tall</div></body>'
	])('rejects unsupported or oversized visual overflow', async (source) => {
		await expect(preview(source)).rejects.toThrow('layout limits');
	});
});
