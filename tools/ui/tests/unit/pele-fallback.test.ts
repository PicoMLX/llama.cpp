import examples from '../fixtures/pico-cards/pele-native-examples.json';
import { isPeleFallbackDiagram, renderPeleFallback } from '$lib/pico-cards/renderers/pele';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Pele fallback selection', () => {
	it('routes exactly the six missing examples from the 32-family native fixture set', () => {
		expect(examples).toHaveLength(91);
		expect(new Set(examples.map(({ family }) => family)).size).toBe(32);
		expect(
			examples
				.filter(({ source }) => isPeleFallbackDiagram(source))
				.map(({ family }) => family)
				.sort()
		).toEqual(['agentflow', 'agentflow', 'agentflow', 'usecase', 'usecase', 'usecase']);
	});

	it.each(['usecase-beta', 'agentflow-beta'])(
		'recognizes %s after frontmatter and comments, including CRLF',
		async (family) => {
			const source = `\uFEFF  ---\r\ntitle: Diagram\r\n---\r\n%% Comment\r\n\r\n${family} TB`;

			expect(isPeleFallbackDiagram(source)).toBe(true);
			expect(isPeleFallbackDiagram(`${family}-extra`)).toBe(false);
		}
	);

	it('rejects unsupported, oversized, cancelled and invalid requests before starting a worker', async () => {
		await expect(renderPeleFallback('flowchart TD\nA --> B', false)).rejects.toThrow('Mermaid.js');
		await expect(renderPeleFallback(`usecase-beta\n${'x'.repeat(32_768)}`, false)).rejects.toThrow(
			'size limits'
		);
		await expect(
			renderPeleFallback(`agentflow-beta\r${'\r'.repeat(1_024)}`, false)
		).rejects.toThrow('size limits');
		await expect(
			renderPeleFallback('usecase-beta', false, { signal: AbortSignal.abort() })
		).rejects.toMatchObject({ name: 'AbortError' });
		await expect(renderPeleFallback('usecase-beta', false, { maxWidth: NaN })).rejects.toThrow(
			'Invalid'
		);
		await expect(renderPeleFallback('agentflow-beta', false, { timeoutMs: 0 })).rejects.toThrow(
			'Invalid'
		);
	});

	it('keeps the runtime identical to the versioned native bundle', async () => {
		const runtimeDirectory = new URL('../../static/pico-runtime/pele/', import.meta.url);
		const bundle = await readFile(new URL('pele-bundle.js', runtimeDirectory));
		const metadata = JSON.parse(await readFile(new URL('Versions.json', runtimeDirectory), 'utf8'));

		expect(metadata.version).toBe('1.9.1');
		expect(createHash('sha256').update(bundle).digest('hex')).toBe(metadata.bundleSHA256);
		expect(bundle.toString('utf8')).toContain('Pele 1.9.1 | MIT License');
		await expect(readFile(new URL('LICENSE.txt', runtimeDirectory), 'utf8')).resolves.toContain(
			'MIT License'
		);
	});
});
