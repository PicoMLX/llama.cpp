import { config } from '$lib/stores/settings.svelte';
import { selectedModelOption } from '$lib/stores/models.svelte';
import { serverStore } from '$lib/stores/server.svelte';

/**
 * Gets vision support based on current mode:
 * - If modelSelectorEnabled: Check selected model's capabilities
 * - Otherwise: Check server props modalities
 */
export function supportsVision(): boolean {
	const currentConfig = config();

	if (currentConfig.modelSelectorEnabled) {
		const selected = selectedModelOption();
		if (selected) {
			return selected.capabilities.includes('vision');
		}
		// Fallback to server if no model selected
	}

	return serverStore.supportsVision;
}

/**
 * Gets audio support based on current mode:
 * - If modelSelectorEnabled: Check selected model's capabilities
 * - Otherwise: Check server props modalities
 */
export function supportsAudio(): boolean {
	const currentConfig = config();

	if (currentConfig.modelSelectorEnabled) {
		const selected = selectedModelOption();
		if (selected) {
			return selected.capabilities.includes('audio');
		}
		// Fallback to server if no model selected
	}

	return serverStore.supportsAudio;
}
