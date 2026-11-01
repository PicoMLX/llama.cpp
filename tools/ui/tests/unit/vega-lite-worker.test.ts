import {
	renderInVegaWorker,
	VEGA_RENDER_TIMEOUT_MS,
	type VegaWorker
} from '$lib/pico-cards/renderers/vega-lite/worker-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

function worker(): VegaWorker {
	return { onerror: null, onmessage: null, postMessage: vi.fn(), terminate: vi.fn() };
}
const request = { dark: false, source: '{"mark":"bar"}', width: 400 };

afterEach(() => vi.useRealTimers());

describe('Vega-Lite worker lifetime', () => {
	it('terminates after a successful render and ignores stale replies', async () => {
		const runtime = worker();
		const rendered = renderInVegaWorker(() => runtime, request, new AbortController().signal);

		runtime.onmessage?.({ data: { svg: '<svg/>' } } as MessageEvent);
		await expect(rendered).resolves.toBe('<svg/>');
		expect(runtime.terminate).toHaveBeenCalledOnce();
		expect(runtime.onmessage).toBeNull();
	});

	it('terminates a stalled runtime at the deadline', async () => {
		vi.useFakeTimers();
		const runtime = worker();
		const rendered = renderInVegaWorker(() => runtime, request, new AbortController().signal);
		const rejected = expect(rendered).rejects.toThrow('timed out');

		await vi.advanceTimersByTimeAsync(VEGA_RENDER_TIMEOUT_MS);
		await rejected;
		expect(runtime.terminate).toHaveBeenCalledOnce();
	});

	it('cancels an in-flight worker and never starts an already cancelled request', async () => {
		const runtime = worker();
		const controller = new AbortController();
		const create = vi.fn(() => runtime);
		const rendered = renderInVegaWorker(create, request, controller.signal);

		controller.abort();
		await expect(rendered).rejects.toMatchObject({ name: 'AbortError' });
		expect(runtime.terminate).toHaveBeenCalledOnce();
		await expect(renderInVegaWorker(create, request, controller.signal)).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(create).toHaveBeenCalledOnce();
	});

	it('releases the runtime on both render failures and worker errors', async () => {
		for (const errorEvent of [false, true]) {
			const runtime = worker();
			const rendered = renderInVegaWorker(() => runtime, request, new AbortController().signal);

			if (errorEvent) runtime.onerror?.({} as ErrorEvent);
			else runtime.onmessage?.({ data: { error: true } } as MessageEvent);

			await expect(rendered).rejects.toThrow();
			expect(runtime.terminate).toHaveBeenCalledOnce();
		}
	});
});
