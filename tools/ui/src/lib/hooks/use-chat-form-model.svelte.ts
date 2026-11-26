/**
 * Model state for the chat form's action bar.
 *
 * Syncs the conversation's model into the global selection (a conversation
 * opened from history names the model that produced it), falls back to a
 * loading, then the first loaded, model on a router, and reactively tracks
 * which modalities (vision / audio / video) the active model supports -
 * fetching model props from the server on demand if they are not cached yet.
 */

import { IS_PICO_BUILD } from '$lib/constants';
import { conversationsStore, modelsStore, serverStore } from '$lib/stores';
import type { DatabaseMessage } from '$lib/types/database';
import { getConversationModel } from '$lib/utils';
import { untrack } from 'svelte';

interface UseChatFormModelOptions {
	synchronizeSelection?: () => boolean;
}

export function useChatFormModel(options: UseChatFormModelOptions = {}) {
	const isRouter = $derived(serverStore.isRouterMode);
	const supportsModelSelection = $derived(serverStore.supportsModelSelection);
	const conversationModel = $derived(
		getConversationModel(conversationsStore.activeMessages as DatabaseMessage[])
	);

	let lastSyncedConversationModel: string | null = null;
	let lastSyncedConversationId: string | null | undefined;

	// the conversation's model wins while it names one: opening a history chat
	// points the selection at the model that produced it
	$effect(() => {
		if (options.synchronizeSelection?.() === false) return;

		if (IS_PICO_BUILD) {
			if (!supportsModelSelection) return;

			const conversationId = conversationsStore.activeConversation?.id ?? null;

			if (conversationId !== lastSyncedConversationId) {
				if (conversationModel && modelsStore.models.length === 0) return;

				lastSyncedConversationId = conversationId;

				if (conversationModel) {
					untrack(() => {
						if (modelsStore.models.some((model) => model.model === conversationModel)) {
							modelsStore.selectModelByName(conversationModel);
						} else {
							modelsStore.clearSelection();
						}
					});
				}
			}

			if (
				isRouter &&
				!modelsStore.selectedModelId &&
				!conversationModel &&
				conversationsStore.activeMessages.length > 0
			) {
				const visible = modelsStore.getVisibleModels();
				const first =
					visible.find((model) => modelsStore.isModelLoading(model.model)) ??
					visible.find((model) => modelsStore.loadedModelIds.includes(model.model));

				if (first) untrack(() => void modelsStore.selectModelById(first.id));
			}

			return;
		}

		if (conversationModel && conversationModel !== lastSyncedConversationModel) {
			if (modelsStore.models.some((m) => m.model === conversationModel)) {
				modelsStore.selectedModelName = conversationModel;
				modelsStore.selectModelByName(conversationModel);
			} else {
				modelsStore.selectedModelName = null;
				modelsStore.clearSelection();
			}

			lastSyncedConversationModel = conversationModel;
		} else if (
			isRouter &&
			!modelsStore.selectedModelId &&
			conversationsStore.activeMessages.length > 0 &&
			!conversationModel
		) {
			lastSyncedConversationModel = null;
			// a model that is loading wins over one that is already up; a model the
			// selector doesn't list is never picked
			const visible = modelsStore.getVisibleModels();
			const first =
				visible.find((m) => modelsStore.isModelLoading(m.model)) ??
				visible.find((m) => modelsStore.loadedModelIds.includes(m.model));

			if (first) modelsStore.selectModelById(first.id);
		}
	});

	const activeModelId = $derived(modelsStore.activeModelId);

	let modelPropsVersion = $state(0); // Used to trigger reactivity after fetch

	$effect(() => {
		if (activeModelId) {
			const cached = modelsStore.props.getModelProps(activeModelId);

			if (!cached) {
				modelsStore.props.fetchModelProps(activeModelId).then(() => {
					modelPropsVersion++;
				});
			}
		}
	});

	const hasAudioModality = $derived.by(() => {
		void modelPropsVersion;

		return activeModelId ? modelsStore.props.modelSupportsAudio(activeModelId) : false;
	});
	const hasVideoModality = $derived.by(() => {
		void modelPropsVersion;

		return activeModelId ? modelsStore.props.modelSupportsVideo(activeModelId) : false;
	});
	const hasVisionModality = $derived.by(() => {
		void modelPropsVersion;

		return activeModelId ? modelsStore.props.modelSupportsVision(activeModelId) : false;
	});
	const hasModelSelected = $derived(
		IS_PICO_BUILD
			? !!activeModelId
			: !supportsModelSelection || !!conversationModel || !!modelsStore.selectedModelId
	);
	const isSelectedModelInCache = $derived.by(() => {
		if (IS_PICO_BUILD) return activeModelId !== null;

		if (!supportsModelSelection) return true;

		if (conversationModel) {
			return modelsStore.models.some((option) => option.model === conversationModel);
		}

		const currentModelId = modelsStore.selectedModelId;

		if (!currentModelId) return false;

		return modelsStore.models.some((option) => option.id === currentModelId);
	});

	return {
		get conversationModel() {
			return conversationModel;
		},
		get hasAudioModality() {
			return hasAudioModality;
		},
		get hasModelSelected() {
			return hasModelSelected;
		},
		get hasVideoModality() {
			return hasVideoModality;
		},
		get hasVisionModality() {
			return hasVisionModality;
		},
		get isRouter() {
			return isRouter;
		},
		get isSelectedModelInCache() {
			return isSelectedModelInCache;
		}
	};
}
