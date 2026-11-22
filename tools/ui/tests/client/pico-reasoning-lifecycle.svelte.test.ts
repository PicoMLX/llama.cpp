import PicoReasoningHarness from './components/PicoReasoningHarness.svelte';
import { MODEL_PROPS_CACHE } from '$lib/constants';
import { ServerModelStatus, ServerRole } from '$lib/enums';
import { PropsService } from '$lib/services/props.service';
import { conversationsStore, modelsStore, serverStore } from '$lib/stores';
import type { ApiLlamaCppServerProps, ApiModelDataEntry } from '$lib/types';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

const FIRST_MODEL = 'reasoning-lifecycle/first';
const SECOND_MODEL = 'reasoning-lifecycle/second';

let unmount: (() => Promise<void>) | undefined;

function listing(id: string): ApiModelDataEntry {
	return {
		created: 0,
		id,
		in_cache: true,
		object: 'model',
		owned_by: 'llamacpp',
		path: `/models/${id}`,
		status: { value: ServerModelStatus.LOADED }
	};
}

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	modelsStore.models = [];
	modelsStore.routerModels = [];
	modelsStore.clearSelection();
	serverStore.role = null;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('refreshes expired router reasoning metadata and stops refreshing a replaced or unmounted model', async () => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
	vi.setSystemTime(0);
	serverStore.role = ServerRole.ROUTER;
	conversationsStore.activeConversation = null;
	conversationsStore.activeMessages = [];
	modelsStore.models = [FIRST_MODEL, SECOND_MODEL].map((model) => ({
		capabilities: [],
		id: model,
		model,
		name: model
	}));
	modelsStore.routerModels = [listing(FIRST_MODEL), listing(SECOND_MODEL)];
	modelsStore.selectedModelId = FIRST_MODEL;
	modelsStore.selectedModelName = FIRST_MODEL;
	let firstRequests = 0;

	const fetchProps = vi.spyOn(PropsService, 'fetchForModel').mockImplementation(async (model) => {
		if (model === FIRST_MODEL) firstRequests++;

		return {
			chat_template_caps: {
				reasoning_effort_levels:
					model === FIRST_MODEL && firstRequests === 1 ? ['low', 'high'] : ['medium']
			}
		} as ApiLlamaCppServerProps;
	});
	const screen = render(PicoReasoningHarness);

	unmount = screen.unmount;
	const levels = screen.getByRole('status', { name: 'Reasoning levels' });

	await expect.element(levels).toHaveTextContent('high');
	expect(fetchProps).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(MODEL_PROPS_CACHE.TTL_MS + 1);
	await expect.element(levels).toHaveTextContent('medium');
	await expect.element(levels).not.toHaveTextContent('high');
	expect(firstRequests).toBe(2);

	modelsStore.selectedModelId = SECOND_MODEL;
	modelsStore.selectedModelName = SECOND_MODEL;
	await expect
		.poll(() => fetchProps.mock.calls.filter(([id]) => id === SECOND_MODEL).length)
		.toBe(1);
	await vi.advanceTimersByTimeAsync(MODEL_PROPS_CACHE.TTL_MS + 1);
	expect(fetchProps.mock.calls.filter(([id]) => id === SECOND_MODEL)).toHaveLength(2);
	expect(firstRequests).toBe(2);
	await screen.unmount();
	unmount = undefined;
	const requestsAfterUnmount = fetchProps.mock.calls.length;

	await vi.advanceTimersByTimeAsync(MODEL_PROPS_CACHE.TTL_MS + 1);
	expect(fetchProps).toHaveBeenCalledTimes(requestsAfterUnmount);
});
