import { ModelsService } from '$lib/services/models.service';
import { formatModelDisplayName, modelDisplayNameKey } from '$lib/utils/model-display-name';
import { describe, expect, it } from 'vitest';

describe('selector display names', () => {
	it.each([
		['mlx-community/Inkling-3.1-24B-8bit', 'Inkling 3.1'],
		['/models/Gemma-4-12B-it-Q4_K_M.gguf', 'Gemma 4 it'],
		['Qwen/Qwen3-30B-A3B-Instruct-2507:Q4_K_M', 'Qwen3 Instruct 2507'],
		['example/Inkling-v2-MLX-4bit', 'Inkling v2'],
		['example/Model-3.2.1-8B-F16', 'Model 3.2.1'],
		['example/Inkling-3.1-24B-4.5bpw', 'Inkling 3.1']
	])('formats %s without changing its raw identity', (raw, label) => {
		const parsed = ModelsService.parseModelId(raw);
		const before = structuredClone(parsed);

		expect(formatModelDisplayName(parsed)).toBe(label);
		expect(parsed).toEqual(before);
		expect(parsed.raw).toBe(raw);
	});

	it('uses a unique alias consistently and falls back to the parsed name for several aliases', () => {
		const parsed = ModelsService.parseModelId('example/Inkling-v2-24B:Q8_0');

		expect(formatModelDisplayName(parsed, ['Inkling Pro 2', 'Inkling Pro 2'])).toBe(
			'Inkling Pro 2'
		);
		expect(formatModelDisplayName(parsed, ['First alias', 'Second alias'])).toBe('Inkling v2');
	});

	it('detects cleaned precision collisions while retaining meaningful variants and capacities', () => {
		const key = (raw: string) => modelDisplayNameKey(ModelsService.parseModelId(raw));

		expect(key('mlx-community/Model-4bit')).toBe(key('mlx-community/Model-8bit'));
		expect(key('Qwen/Qwen3-30B-A3B-Instruct-2507:Q4_K_M')).not.toBe(
			key('Qwen/Qwen3-30B-A3B-Thinking-2507:Q4_K_M')
		);
		expect(key('Qwen/Qwen3-30B-A3B:Q4_K_M')).not.toBe(key('Qwen/Qwen3-235B-A3B:Q4_K_M'));
		expect(key('Qwen/Qwen3-235B-A3B:Q4_K_M')).not.toBe(key('Qwen/Qwen3-235B-A22B:Q4_K_M'));
		expect(key('example/Model:Q4_K_M')).not.toBe(key('example/Model:Q4_K_M-mtp'));
	});

	it('uses the same alias identity when deciding which rows need disambiguation', () => {
		const first = ModelsService.parseModelId('example/First-4bit');
		const second = ModelsService.parseModelId('example/Second-8bit');

		expect(modelDisplayNameKey(first, ['Shared-name'])).toBe(
			modelDisplayNameKey(second, ['Shared name'])
		);
	});
});
