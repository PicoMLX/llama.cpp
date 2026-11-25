import { MODEL_ID } from '$lib/constants/model-id.constants';
import type { ParsedModelId } from '$lib/types/models';

export function formatModelDisplayName(
	parsed: ParsedModelId,
	aliases: readonly string[] = []
): string {
	const uniqueAliases = [...new Set(aliases)];
	const name =
		uniqueAliases.length === 1
			? uniqueAliases[0]
			: [parsed.modelName, ...parsed.tags].filter(Boolean).join('-') || parsed.raw;
	const formatted = name
		.replace(/(?:^|[-_\s])(?:mlx|gguf|ggml|\d+(?:\.\d+)?[-_\s]?(?:bit|bpw))(?=$|[-_\s])/gi, ' ')
		.split(/[-\s]+/)
		.filter((part) => !MODEL_ID.QUANTIZATION_SEGMENT_REGEX.test(part))
		.join(' ')
		.replace(/_+/g, ' ')
		.trim();

	return formatted || name;
}

export function modelDisplayNameKey(
	parsed: ParsedModelId,
	aliases: readonly string[] = []
): string {
	return JSON.stringify([
		formatModelDisplayName(parsed, aliases),
		parsed.params,
		parsed.activatedParams,
		parsed.sidecar
	]);
}
