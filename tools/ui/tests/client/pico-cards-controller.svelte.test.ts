import '$lib/pico-cards/styles.css';
import { PicoCardController } from '$lib/pico-cards/controller';
import { rehypePicoCards } from '$lib/pico-cards/plugin';
import {
	PICO_CARD_SELECTOR,
	type PicoCardContext,
	type PicoCardRenderer
} from '$lib/pico-cards/types';
import { copyToClipboard } from '$lib/utils/clipboard';
import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkRehype from 'remark-rehype';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

const controllers: PicoCardController[] = [];
const containers: HTMLElement[] = [];

function controller(renderer: PicoCardRenderer): PicoCardController {
	const instance = new PicoCardController({ openui: renderer });

	controllers.push(instance);

	return instance;
}

async function container(source: string, count = 1): Promise<HTMLDivElement> {
	const processor = remark().use(remarkRehype).use(rehypePicoCards).use(rehypeStringify);
	const markdown = Array.from({ length: count }, () => `\`\`\`openui\n${source}\n\`\`\``).join(
		'\n\n'
	);
	const root = document.createElement('div');

	root.className = 'markdown-content';
	root.style.width = '640px';
	root.innerHTML = String(await processor.process(markdown));
	document.body.appendChild(root);
	containers.push(root);

	return root;
}

function deferred() {
	let resolve!: () => void;

	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});

	return { promise, resolve };
}

afterEach(() => {
	controllers.splice(0).forEach((instance) => instance.destroy());
	containers.splice(0).forEach((element) => element.remove());
	vi.clearAllMocks();
});

describe('PicoCardController lifecycle', () => {
	it('owns repeated identical cards separately and preserves input state on context updates', async () => {
		const disposals: ReturnType<typeof vi.fn>[] = [];
		const updates: ReturnType<typeof vi.fn>[] = [];
		const contexts: PicoCardContext[] = [];
		const render = vi.fn<PicoCardRenderer>(async (host, _source, context) => {
			const input = document.createElement('input');
			const dispose = vi.fn();
			const update = vi.fn();

			contexts.push(context);
			disposals.push(dispose);
			updates.push(update);
			host.appendChild(input);

			return { dispose, update };
		});
		const root = await container('root = Text("Hello")', 2);
		const instance = controller(render);
		const onAction = vi.fn();

		instance.sync(root, { dark: false, onAction });
		await expect
			.poll(() => root.querySelectorAll('.pico-card-render:not(.pico-card-render--pending)').length)
			.toBe(2);

		const input = root.querySelector('input')!;

		input.value = 'Keep this answer';
		root.style.width = '520px';
		instance.sync(root, { dark: true, onAction });

		await expect
			.poll(() =>
				updates.every((update) => update.mock.calls.some(([ctx]) => ctx.dark && ctx.width > 32))
			)
			.toBe(true);
		expect(render).toHaveBeenCalledTimes(2);
		expect(new Set(contexts.map((context) => context.id)).size).toBe(2);
		expect(root.querySelector('input')).toBe(input);
		expect(input.value).toBe('Keep this answer');

		const card = root.querySelector<HTMLElement>(PICO_CARD_SELECTOR)!;
		const sourceButton = card.querySelector<HTMLButtonElement>('[data-pico-action="source"]')!;

		sourceButton.click();
		sourceButton.click();
		expect(input.value).toBe('Keep this answer');

		const expandButton = card.querySelector<HTMLButtonElement>('[data-pico-action="expand"]')!;

		expandButton.click();
		await expect
			.poll(() => document.fullscreenElement === card || card.matches(':popover-open'))
			.toBe(true);
		expect(root.querySelector('input')).toBe(input);
		expect(input.value).toBe('Keep this answer');
		expandButton.click();
		await expect
			.poll(() => document.fullscreenElement === card || card.matches(':popover-open'))
			.toBe(false);

		const changedAction = vi.fn();

		instance.sync(root, { dark: true, onAction: changedAction });
		contexts[0].onAction?.({ type: 'submit' });
		expect(changedAction).toHaveBeenCalledOnce();
		expect(onAction).not.toHaveBeenCalled();

		instance.destroy();
		contexts[0].onAction?.({ type: 'submit' });
		expect(changedAction).toHaveBeenCalledOnce();
		expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
	});

	it('serializes updates so a theme change reversed during an async update is retained', async () => {
		const updating = deferred();
		const update = vi.fn(async (context: PicoCardContext) => {
			if (context.dark) await updating.promise;
		});
		const render = vi.fn<PicoCardRenderer>(async () => ({ dispose: vi.fn(), update }));
		const root = await container('root = Text("Hello")');
		const instance = controller(render);

		instance.sync(root, { dark: false });
		await expect.poll(() => root.querySelector('.pico-card-render--pending')).toBeNull();
		instance.sync(root, { dark: true });
		await expect.poll(() => update.mock.calls.length).toBe(1);
		instance.sync(root, { dark: false });
		updating.resolve();
		await expect.poll(() => update.mock.calls.length).toBe(2);
		expect(update.mock.calls[1][0].dark).toBe(false);
		expect(render).toHaveBeenCalledOnce();
	});

	it('keeps pending iframe animation frames running without showing or focusing the preview', async () => {
		const render = vi.fn<PicoCardRenderer>(async (host, _source, context) => {
			expect(host.isConnected).toBe(true);
			expect(host.getBoundingClientRect().width).toBeGreaterThan(32);
			expect(context.width).toBeGreaterThan(32);
			expect(getComputedStyle(host).visibility).toBe('visible');
			expect(getComputedStyle(host).opacity).toBe('0');
			expect(getComputedStyle(host).pointerEvents).toBe('none');
			expect(host.inert).toBe(true);
			expect(host.getAttribute('aria-hidden')).toBe('true');
			expect(
				host.closest(PICO_CARD_SELECTOR)?.querySelector<HTMLElement>('[data-pico-source-view]')
					?.hidden
			).toBe(false);

			const frame = document.createElement('iframe');
			const loaded = new Promise<void>((resolve) =>
				frame.addEventListener('load', () => resolve(), { once: true })
			);

			frame.srcdoc = '<p>Ready</p>';
			host.appendChild(frame);
			await loaded;
			await new Promise<void>((resolve) =>
				frame.contentWindow!.requestAnimationFrame(() => resolve())
			);

			return { dispose: () => frame.remove() };
		});
		const root = await container('root = Text("Hello")');

		controller(render).sync(root, { dark: false });
		await expect.poll(() => root.querySelector('.pico-card-render--pending')).toBeNull();
		expect(root.querySelector('iframe')?.isConnected).toBe(true);
		expect(root.querySelector<HTMLElement>('[data-pico-source-view]')?.hidden).toBe(true);
		expect(root.querySelector<HTMLElement>('.pico-card-render')?.inert).toBe(false);
		expect(root.querySelector('.pico-card-render')?.hasAttribute('aria-hidden')).toBe(false);
	});

	it.each(['removal', 'destroy'])(
		'aborts %s and disposes late async results without mounting stale output',
		async (mode) => {
			const pending = deferred();
			const dispose = vi.fn();
			const signals: AbortSignal[] = [];
			const render = vi.fn<PicoCardRenderer>(async (host, _source, context) => {
				signals.push(context.signal);
				await pending.promise;
				const stale = document.createElement('span');

				stale.setAttribute('data-stale-result', 'true');
				host.appendChild(stale);

				return { dispose };
			});
			const root = await container('root = Text("Hello")');
			const instance = controller(render);

			instance.sync(root, { dark: false });
			await expect.poll(() => render.mock.calls.length).toBe(1);

			if (mode === 'destroy') instance.destroy();
			else {
				root.querySelector(PICO_CARD_SELECTOR)!.remove();
				instance.sync(root, { dark: false });
			}

			expect(signals[0].aborted).toBe(true);
			pending.resolve();
			await expect.poll(() => dispose.mock.calls.length).toBe(1);
			expect(document.querySelector('[data-stale-result]')).toBeNull();
		}
	);

	it('keeps invalid source readable and copies its exact whitespace', async () => {
		const source = '  invalid <b>source</b>  \n\nnext line  ';
		const render = vi.fn<PicoCardRenderer>(async () => {
			throw new Error('Invalid card <b>detail</b>');
		});
		const root = await container(source);

		controller(render).sync(root, { dark: false });
		await expect
			.poll(() => root.querySelector('[data-pico-status]')?.textContent)
			.toContain('Invalid card <b>detail</b>');
		expect(root.querySelector('[data-pico-status] b')).toBeNull();
		expect(root.querySelector<HTMLElement>('[data-pico-source-view]')?.hidden).toBe(false);
		expect(root.querySelector('[data-pico-source-view]')?.textContent).toBe(`${source}\n`);
		root.querySelector<HTMLButtonElement>('[data-pico-action="copy"]')!.click();
		await expect.poll(() => vi.mocked(copyToClipboard).mock.calls.length).toBe(1);
		expect(copyToClipboard).toHaveBeenCalledWith(source);
	});

	it('restores readable source and disposes a live renderer after a later error event', async () => {
		const dispose = vi.fn();
		const contexts: PicoCardContext[] = [];
		const render = vi.fn<PicoCardRenderer>(async (host, _source, context) => {
			contexts.push(context);
			host.appendChild(document.createElement('iframe'));

			return { dispose };
		});
		const source = 'root = Text("Keep the original")';
		const root = await container(source);

		controller(render).sync(root, { dark: false });
		await expect.poll(() => root.querySelector('.pico-card-render--pending')).toBeNull();
		root.querySelector('.pico-card-render')!.dispatchEvent(
			new CustomEvent('pico-card-error', {
				detail: new Error('Preview exceeded its layout bounds')
			})
		);

		expect(dispose).toHaveBeenCalledOnce();
		expect(contexts[0].signal.aborted).toBe(true);
		expect(root.querySelector('iframe')).toBeNull();
		expect(root.querySelector<HTMLElement>('[data-pico-source-view]')?.hidden).toBe(false);
		expect(root.querySelector('[data-pico-source-view]')?.textContent).toBe(`${source}\n`);
		expect(root.querySelector('[data-pico-status]')?.textContent).toContain(
			'Preview exceeded its layout bounds'
		);
	});
});
