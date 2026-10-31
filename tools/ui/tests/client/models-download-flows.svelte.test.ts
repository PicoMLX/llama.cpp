// Guards the download flows the chips depend on: one POST per click, the chip
// reading downloaded once the list reports the model, a resume keeping the
// sidecars it started with, a cancel dropping the whole download, and a reload
// restoring the paused state of an unfinished one.

import { modelRowActions } from '$lib/components/app/models/ModelsManager/row-actions';
import {
	ModelAuxSidecar,
	ModelDraftSidecar,
	ServerModelsSseEventType,
	ServerModelStatus,
	ServerRole
} from '$lib/enums';
import { ModelsService } from '$lib/services/models.service';
import { modelsStore, settingsStore, uiStore } from '$lib/stores';
import { serverStore } from '$lib/stores/server.svelte';
import type {
	ApiLlamaCppServerProps,
	ApiModelDataEntry,
	ApiModelsListResponse,
	ApiModelsSseEvent
} from '$lib/types/api';
import type { ModelOption } from '$lib/types/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REPO = 'org/model-GGUF';
const TAG = `${REPO}:Q4_K_M`;
const DRAFTS = [ModelAuxSidecar.MMPROJ, ModelDraftSidecar.DFLASH];

/** The listing entry a router reports once a tag is downloaded. */
function entry(id: string, sidecars: string[] = [], status = ServerModelStatus.DOWNLOADED) {
	return {
		created: 0,
		id,
		in_cache: true,
		object: 'model',
		owned_by: 'llamacpp',
		path: `/models/${id}`,
		sidecars,
		status: { value: status }
	} as unknown as ApiModelDataEntry;
}

/** The download endpoints the store talks to; the feed is not live in these tests. */
function stubEndpoints() {
	const post = vi.spyOn(ModelsService, 'downloadModel').mockResolvedValue({ success: true });
	const cancel = vi.spyOn(ModelsService, 'cancelDownload').mockResolvedValue({ success: true });
	const unload = vi.spyOn(ModelsService, 'unload').mockResolvedValue({ success: true });

	vi.spyOn(ModelsService, 'watchModelEvents').mockResolvedValue(undefined);
	vi.spyOn(ModelsService, 'list').mockResolvedValue({
		data: [],
		models: [],
		object: 'list'
	} as unknown as ApiModelsListResponse);

	return { cancel, post, unload };
}

describe('model download flows', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		serverStore.props = null;
		serverStore.role = ServerRole.ROUTER;
		modelsStore.routerModels = [];
		// the store is a singleton: drop what an earlier case tracked
		modelsStore.status.unsubscribe();
	});

	it('posts once for two quick clicks on the same chip', async () => {
		const { post } = stubEndpoints();
		const first = modelsStore.status.downloadModel(TAG, [ModelDraftSidecar.DFLASH]);
		const second = modelsStore.status.downloadModel(TAG, [ModelDraftSidecar.DFLASH]);

		// the chip reads in flight before the server answers, so the second click
		// finds it busy instead of posting again
		expect(modelsStore.status.isDownloadInProgress(TAG)).toBe(true);

		await Promise.all([first, second]);

		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith(TAG, DRAFTS);
	});

	it('reads the chip as downloaded once the list reports the model', async () => {
		stubEndpoints();

		await modelsStore.status.downloadModel(TAG, [ModelDraftSidecar.DFLASH]);

		expect(modelsStore.status.isModelDownloaded(TAG)).toBe(false);

		// the feed's reload lands as a listing the tag now appears in
		modelsStore.routerModels = [entry(TAG, DRAFTS)];

		expect(modelsStore.status.isModelDownloaded(TAG)).toBe(true);
		// the sidecar option of that model reads the draft off the same entry
		expect(modelsStore.status.isModelDownloaded(`${TAG}-dflash`)).toBe(true);
	});

	it('does not pause a download whose POST is still on its way', async () => {
		const { post, unload } = stubEndpoints();

		let release: () => void = () => {};

		post.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ success: true });
				})
		);

		const started = modelsStore.status.downloadModel(TAG, [ModelDraftSidecar.DFLASH]);

		// the chip reads as downloading before the server answers, so a second click
		// must not stop a model that never started
		await modelsStore.status.pauseDownload(TAG);

		expect(unload).not.toHaveBeenCalled();
		expect(modelsStore.status.isDownloadInProgress(TAG)).toBe(true);
		expect(modelsStore.status.isDownloadPaused(TAG)).toBe(false);

		release();
		await started;
	});

	it('resumes with the sidecars the download started with', async () => {
		const { post } = stubEndpoints();

		await modelsStore.status.downloadModel(TAG, [ModelDraftSidecar.DFLASH]);
		await modelsStore.status.pauseDownload(TAG);

		expect(modelsStore.status.isDownloadPaused(TAG)).toBe(true);

		// the resume a chip sends names no kinds of its own
		await modelsStore.status.downloadModel(TAG);

		expect(post).toHaveBeenLastCalledWith(TAG, DRAFTS);
		expect(modelsStore.status.isDownloadPaused(TAG)).toBe(false);
	});

	it('cancels the model and its sidecars as one download', async () => {
		const { cancel } = stubEndpoints();

		await modelsStore.status.downloadModel(TAG, [ModelDraftSidecar.DFLASH]);
		await modelsStore.status.cancelDownload(TAG);

		// no sidecar of its own is asked for: the model goes as one unit
		expect(cancel).toHaveBeenCalledWith(TAG, null);
		expect(modelsStore.status.isDownloadInProgress(TAG)).toBe(false);
		expect(modelsStore.status.getDownloadEntries()).toEqual([]);
	});

	it('restores the paused state of an unfinished download after a reload', async () => {
		const { post } = stubEndpoints();

		modelsStore.routerModels = [entry(TAG, DRAFTS, ServerModelStatus.INCOMPLETE)];
		modelsStore.status.syncPausedDownloads();

		expect(modelsStore.status.isDownloadPaused(TAG)).toBe(true);
		expect(modelsStore.status.getDownloadEntries()).toEqual([
			{ isPaused: true, progress: null, repoWithTag: TAG }
		]);

		// and its resume keeps the kinds the incomplete listing reports
		await modelsStore.status.downloadModel(TAG);

		expect(post).toHaveBeenCalledWith(TAG, DRAFTS);
	});
});

describe('Pico model lifecycle compatibility', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		serverStore.props = { server_name: 'Pico' } as ApiLlamaCppServerProps;
		serverStore.role = ServerRole.ROUTER;
		modelsStore.routerModels = [];
		modelsStore.status.unsubscribe();
	});

	it('finishes synchronous load and unload without waiting for model events', async () => {
		stubEndpoints();
		modelsStore.routerModels = [entry(TAG, [], ServerModelStatus.UNLOADED)];
		const refresh = vi.spyOn(modelsStore, 'fetchRouterModels').mockResolvedValue();

		let finishLoad: () => void = () => {};

		vi.spyOn(ModelsService, 'load').mockImplementation(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ success: true });
				})
		);

		const loading = modelsStore.status.load(TAG);
		const waitingForLoad = modelsStore.status.ensureLoaded(TAG);

		expect(modelsStore.status.isOperationInProgress(TAG)).toBe(true);
		finishLoad();
		await Promise.all([loading, waitingForLoad]);

		expect(modelsStore.isModelLoaded(TAG)).toBe(true);
		expect(modelsStore.status.isOperationInProgress(TAG)).toBe(false);

		await modelsStore.status.unload(TAG);

		expect(modelsStore.isModelLoaded(TAG)).toBe(false);
		expect(modelsStore.status.isOperationInProgress(TAG)).toBe(false);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(ModelsService.watchModelEvents).not.toHaveBeenCalled();
	});

	it('can ensure a model already listed as loading without requiring an event stream', async () => {
		stubEndpoints();
		modelsStore.routerModels = [entry(TAG, [], ServerModelStatus.LOADING)];
		vi.spyOn(modelsStore, 'fetchRouterModels').mockResolvedValue();
		const load = vi.spyOn(ModelsService, 'load').mockResolvedValue({ success: true });

		await modelsStore.status.ensureLoaded(TAG);

		expect(load).toHaveBeenCalledWith(TAG);
		expect(modelsStore.isModelLoaded(TAG)).toBe(true);
		expect(ModelsService.watchModelEvents).not.toHaveBeenCalled();
	});

	it('rejects concurrent load waiters when the synchronous load fails', async () => {
		stubEndpoints();
		modelsStore.routerModels = [entry(TAG, [], ServerModelStatus.UNLOADED)];
		vi.spyOn(ModelsService, 'load').mockRejectedValue(new Error('Not enough memory'));

		const loading = modelsStore.status.load(TAG);
		const waitingForLoad = modelsStore.status.ensureLoaded(TAG);

		await expect(loading).rejects.toThrow('Not enough memory');
		await expect(waitingForLoad).rejects.toThrow('Not enough memory');
		expect(modelsStore.status.isOperationInProgress(TAG)).toBe(false);
	});

	it('hides unsupported actions and does not call model download endpoints', async () => {
		const { cancel, post, unload } = stubEndpoints();

		vi.spyOn(settingsStore, 'getConfig').mockReturnValue(true);

		modelsStore.status.subscribe();
		await modelsStore.status.downloadModel(TAG);
		await modelsStore.status.pauseDownload(TAG);
		expect(await modelsStore.status.cancelDownload(TAG)).toBe(false);
		expect(uiStore.isDiscoverEnabled).toBe(false);
		expect(
			modelRowActions({ model: TAG } as ModelOption, false, false, vi.fn()).map(
				(action) => action.label
			)
		).toEqual(['Add to favorites', 'Hide model']);
		expect(post).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
		expect(unload).not.toHaveBeenCalled();
		expect(ModelsService.watchModelEvents).not.toHaveBeenCalled();
	});

	it('keeps llama-server load completion driven by its status event', async () => {
		stubEndpoints();
		serverStore.props = {} as ApiLlamaCppServerProps;
		modelsStore.routerModels = [entry(TAG, [], ServerModelStatus.UNLOADED)];
		vi.spyOn(ModelsService, 'load').mockResolvedValue({ success: true });
		vi.spyOn(modelsStore.props, 'updateModelModalities').mockResolvedValue();
		let onEvent: (event: ApiModelsSseEvent) => void = () => {};

		vi.spyOn(ModelsService, 'watchModelEvents').mockImplementation(async (_, callback) => {
			onEvent = callback;
		});

		const loading = modelsStore.status.load(TAG);

		await Promise.resolve();
		expect(modelsStore.status.isOperationInProgress(TAG)).toBe(true);
		expect(modelsStore.isModelLoaded(TAG)).toBe(false);

		onEvent({
			data: { status: ServerModelStatus.LOADED },
			event: ServerModelsSseEventType.STATUS_CHANGE,
			model: TAG
		});
		await loading;

		expect(modelsStore.isModelLoaded(TAG)).toBe(true);
		expect(modelsStore.status.isOperationInProgress(TAG)).toBe(false);
	});
});
