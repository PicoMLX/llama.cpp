// A model picked by a ?model= link stays selected while another model loads; an automatic pick still moves to the loading model.

import { ServerModelStatus, ServerRole } from '$lib/enums';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import type { ApiModelDataEntry, ModelOption } from '$lib/types';
import { beforeEach, describe, expect, it } from 'vitest';

function option(model: string): ModelOption {
	return { capabilities: [], id: model, model, name: model };
}

function routerEntry(id: string, status: ServerModelStatus): ApiModelDataEntry {
	return {
		created: 0,
		id,
		in_cache: true,
		object: 'model',
		owned_by: 'llamacpp',
		path: `/models/${id}`,
		status: { value: status }
	};
}

const LOADING = option('org/loading:Q4_K_M');
const IDLE = option('org/idle:Q4_K_M');

beforeEach(() => {
	modelsStore.clearSelection();
	modelsStore.models = [LOADING, IDLE];
	modelsStore.favoriteModelIds = new Set();
	modelsStore.hiddenModelIds = new Set();
	modelsStore.routerModels = [
		routerEntry(LOADING.model, ServerModelStatus.LOADING),
		routerEntry(IDLE.model, ServerModelStatus.UNLOADED)
	];
	serverStore.role = ServerRole.ROUTER;
});

describe('model picked by a link', () => {
	it('stays selected when a new chat preselects a model', async () => {
		await modelsStore.selectModelById(IDLE.id, { fromLink: true });
		await modelsStore.ensureFirstModelSelected();

		expect(modelsStore.selectedModelId).toBe(IDLE.id);
	});

	it('stays selected when a chat without a model of its own syncs its model', async () => {
		await modelsStore.selectModelById(IDLE.id, { fromLink: true });

		expect(await modelsStore.selectModelFromLastAssistantResponse()).toBe(false);
		expect(modelsStore.selectedModelId).toBe(IDLE.id);
	});

	it('stays selected when the link names the model that is already selected', async () => {
		await modelsStore.selectModelById(IDLE.id);
		await modelsStore.selectModelById(IDLE.id, { fromLink: true });
		await modelsStore.ensureFirstModelSelected();

		expect(modelsStore.selectedModelId).toBe(IDLE.id);
	});

	it('lets an automatic pick move to the loading model', async () => {
		await modelsStore.selectModelById(IDLE.id);
		await modelsStore.ensureFirstModelSelected();

		expect(modelsStore.selectedModelId).toBe(LOADING.id);
	});

	it('stops protecting the model once another model is selected', async () => {
		await modelsStore.selectModelById(IDLE.id, { fromLink: true });
		await modelsStore.selectModelById(LOADING.id);
		await modelsStore.selectModelById(IDLE.id);
		await modelsStore.ensureFirstModelSelected();

		expect(modelsStore.selectedModelId).toBe(LOADING.id);
	});
});
