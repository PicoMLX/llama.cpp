import fixtures from './fixtures/pico-openui.json';
import { renderOpenUI } from '$lib/pico-cards/renderers/openui';
import { normalizeOpenUIAction } from '$lib/pico-cards/renderers/openui/action';
import type { PicoCardAction, PicoCardContext, PicoCardHandle } from '$lib/pico-cards/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

const hosts: HTMLElement[] = [];
const handles: PicoCardHandle[] = [];
const controllers: AbortController[] = [];
const headings: Record<string, string> = {
	'date-picker': 'Choose a date',
	'markdown-link': 'Read documentation',
	'math-content': 'Inline',
	'project-status': 'Project overview',
	'revenue-chart': 'Q4 revenue',
	'scrollable-modal': 'Scrollable details',
	'trip-form': 'Plan a weekend'
};

function prepare(source: string, id: string = crypto.randomUUID()) {
	const host = document.createElement('div');

	host.style.width = '720px';
	document.body.append(host);
	hosts.push(host);
	const controller = new AbortController();

	controllers.push(controller);
	const actions: PicoCardAction[] = [];
	const context: PicoCardContext = {
		dark: false,
		id,
		onAction: (action) => actions.push(action),
		signal: controller.signal,
		width: 720
	};
	const promise = renderOpenUI(host, source, context);
	const iframe = host.querySelector('iframe');

	if (iframe) iframe.dataset.testid = id;

	return { actions, context, controller, host, iframe, promise };
}

async function mount(source: string, id: string = crypto.randomUUID()) {
	const instance = prepare(source, id);
	const handle = await instance.promise;

	handles.push(handle);

	return { ...instance, frame: page.frameLocator(page.getByTestId(id)), handle };
}

afterEach(() => {
	for (const handle of handles.splice(0)) handle.dispose();
	for (const controller of controllers.splice(0)) controller.abort();
	for (const host of hosts.splice(0)) host.remove();
	vi.useRealTimers();
});

describe('offline official OpenUI runtime', () => {
	it.each(fixtures)('renders the native $id fixture', async (fixture) => {
		const instance = await mount(fixture.source);

		await instance.frame.getByText(headings[fixture.id], { exact: false }).first().click();
		expect(instance.iframe?.sandbox.contains('allow-scripts')).toBe(true);
		expect(instance.iframe?.sandbox.contains('allow-forms')).toBe(true);
		expect(instance.iframe?.sandbox.contains('allow-same-origin')).toBe(false);
		expect(Number.parseFloat(instance.iframe?.style.height ?? '0')).toBeGreaterThan(0);
	});

	it('isolates repeated identical programs and ignores messages from other sources', async () => {
		const first = await mount(fixtures[0].source, 'first-occurrence');
		const second = await mount(fixtures[0].source, 'second-occurrence');

		expect(first.iframe!.contentWindow !== second.iframe!.contentWindow).toBe(true);
		const parameters = JSON.parse(
			first.iframe!.srcdoc.match(/window\.__picoOpenUIHost = (\{[^\n]+?\});/)![1]
		);
		const data = {
			channel: parameters.channel,
			id: first.context.id,
			kind: 'action',
			namespace: 'pico-openui',
			payload: { humanFriendlyMessage: 'forged', type: 'continue_conversation' },
			version: 1
		};

		window.dispatchEvent(
			new MessageEvent('message', { data, origin: 'null', source: second.iframe!.contentWindow })
		);
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { ...data, channel: 'wrong-channel' },
				origin: 'null',
				source: first.iframe!.contentWindow
			})
		);
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { ...data, id: 'wrong-occurrence' },
				origin: 'null',
				source: first.iframe!.contentWindow
			})
		);
		expect(first.actions).toEqual([]);
		expect(second.actions).toEqual([]);
	});

	it('reports late runtime errors and releases the iframe', async () => {
		const instance = await mount(fixtures[1].source);
		const errors: Event[] = [];

		instance.host.addEventListener('pico-card-error', (event) => errors.push(event));
		const parameters = JSON.parse(
			instance.iframe!.srcdoc.match(/window\.__picoOpenUIHost = (\{[^\n]+?\});/)![1]
		);

		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					channel: parameters.channel,
					id: instance.context.id,
					kind: 'error',
					namespace: 'pico-openui',
					payload: [{ code: 'runtime-error' }],
					version: 1
				},
				origin: 'null',
				source: instance.iframe!.contentWindow
			})
		);
		expect(errors).toHaveLength(1);
		expect(instance.host.querySelector('iframe')).toBeNull();
	});

	it('rejects invalid source and removes the unsuccessful iframe', async () => {
		const instance = prepare('root = NoSuchComponent("invalid")');

		await expect(instance.promise).rejects.toThrow('OpenUI content could not be rendered.');
		expect(instance.host.querySelector('iframe')).toBeNull();
	});

	it('cancels pending renders and disposes mounted frames', async () => {
		const pending = prepare(fixtures[0].source);

		pending.controller.abort();
		await expect(pending.promise).rejects.toMatchObject({ name: 'AbortError' });
		expect(pending.host.querySelector('iframe')).toBeNull();
		const mounted = await mount(fixtures[1].source);

		mounted.handle.dispose();
		expect(mounted.host.querySelector('iframe')).toBeNull();
		mounted.handle.dispose();
	});

	it('times out a runtime that never becomes ready', async () => {
		vi.useFakeTimers();
		const instance = prepare(fixtures[0].source);

		instance.iframe!.src = 'about:blank';
		const rejection = expect(instance.promise).rejects.toThrow('OpenUI preview timed out.');

		await vi.advanceTimersByTimeAsync(15_001);
		await rejection;
		expect(instance.host.querySelector('iframe')).toBeNull();
	});

	it('accepts only bounded JSON actions with known semantic types', () => {
		expect(
			normalizeOpenUIAction({ params: { code: 'alert(1)' }, type: 'run_javascript' })
		).toBeNull();
		expect(normalizeOpenUIAction({ formState: [], type: 'continue_conversation' })).toBeNull();
		expect(
			normalizeOpenUIAction({ params: { value: Infinity }, type: 'continue_conversation' })
		).toBeNull();
		expect(
			normalizeOpenUIAction({ params: { url: 'https://example.com' }, type: 'open_url' })
		).toEqual({
			params: { url: 'https://example.com' },
			type: 'open_url'
		});
	});
});
