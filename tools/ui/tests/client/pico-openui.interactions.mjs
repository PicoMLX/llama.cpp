import { expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Direct Playwright interactions avoid Vitest's injected eval in opaque frames.
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = path.join(ui, 'static/pico-runtime/openui');
const fixtures = JSON.parse(
	await readFile(path.join(ui, 'tests/client/fixtures/pico-openui.json'), 'utf8')
);
const scratch = await mkdtemp(path.join(tmpdir(), 'pico-openui-browser-'));
const bundle = await build({
	bundle: true,
	format: 'iife',
	globalName: 'PicoOpenUIRenderer',
	platform: 'browser',
	plugins: [
		{
			name: 'app-paths',
			setup(builder) {
				builder.onResolve({ filter: /^\$app\/paths$/ }, () => ({
					namespace: 'pico-test',
					path: 'paths'
				}));
				builder.onLoad({ filter: /.*/, namespace: 'pico-test' }, () => ({
					contents: "export const base = '';",
					loader: 'js'
				}));
			}
		}
	],
	stdin: {
		contents:
			"export { renderOpenUI } from './src/lib/pico-cards/renderers/openui'; export { isOpenUIUserAction } from './src/lib/pico-cards/renderers/openui/action';",
		loader: 'ts',
		resolveDir: ui
	},
	write: false
});
const rootHTML = `<!doctype html><html><head><meta charset="utf-8"><title>OpenUI browser checks</title></head><body>
<script src="/renderer.js"></script><script>
window.instances = new Map();
window.mountCard = async (source, id) => {
  const host = document.createElement('div'); host.style.width = '720px'; document.body.append(host);
  const controller = new AbortController(); const actions = []; const trusted = [];
  const context = {id, dark:false, width:720, signal:controller.signal, onAction: action => { actions.push(action); trusted.push(PicoOpenUIRenderer.isOpenUIUserAction(action)); }};
  const handle = await PicoOpenUIRenderer.renderOpenUI(host, source, context);
  host.querySelector('iframe').dataset.testid = id;
  instances.set(id, {host, context, handle, controller, actions, trusted});
};
</script></body></html>`;
const server = http.createServer(async (request, response) => {
	response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
	response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
	const pathname = new URL(request.url, 'http://localhost').pathname;

	if (pathname === '/favicon.ico') {
		response.writeHead(204);
		response.end();

		return;
	}

	if (pathname === '/') {
		response.setHeader('Content-Type', 'text/html');
		response.end(rootHTML);

		return;
	}

	if (pathname === '/renderer.js') {
		response.setHeader('Content-Type', 'text/javascript');
		response.end(bundle.outputFiles[0].text);

		return;
	}

	const name = pathname.slice('/pico-runtime/openui/'.length);

	if (
		!pathname.startsWith('/pico-runtime/openui/') ||
		!['app.js', 'browser-host.js', 'browser.css'].includes(name)
	) {
		response.writeHead(404);
		response.end();

		return;
	}

	response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
	response.end(await readFile(path.join(assets, name)));
});

let browser;

try {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;

	browser = await chromium.launch({
		headless: true,
		...(process.env.PICO_BROWSER_CHANNEL ? { channel: process.env.PICO_BROWSER_CHANNEL } : {})
	});
	const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
	const errors = [];
	const external = [];

	page.on('pageerror', (error) => errors.push(String(error)));
	page.on('request', (request) => {
		if (!request.url().startsWith(origin) && !/^(data:|blob:|about:)/.test(request.url()))
			external.push(request.url());
	});
	await page.goto(origin);
	await page.evaluate(({ source }) => window.mountCard(source, 'first'), fixtures[0]);
	await page.evaluate(({ source }) => window.mountCard(source, 'second'), fixtures[0]);
	const first = page.frameLocator('[data-testid="first"]');
	const second = page.frameLocator('[data-testid="second"]');

	await first.getByPlaceholder('Your name').fill('Ada Lovelace');
	await first.getByPlaceholder('you@example.com').fill('ada@example.com');
	await expect(second.getByPlaceholder('Your name')).toHaveValue('');
	await second.getByPlaceholder('Your name').fill('Grace Hopper');
	await second.getByPlaceholder('you@example.com').fill('grace@example.com');
	await page.evaluate(() => {
		const instance = window.instances.get('first');

		instance.handle.update({ ...instance.context, dark: true, width: 480 });
	});
	await expect(first.locator('html')).toHaveAttribute('style', /color-scheme: dark/);
	await expect(first.getByPlaceholder('Your name')).toHaveValue('Ada Lovelace');
	await expect(second.getByPlaceholder('Your name')).toHaveValue('Grace Hopper');
	await expect(page.locator('[data-testid="first"]')).toHaveCSS('width', '480px');
	await first.getByRole('button', { exact: true, name: 'Plan trip' }).click();
	await second.getByRole('button', { exact: true, name: 'Plan trip' }).click();
	await page.waitForFunction(
		() =>
			window.instances.get('first').actions.length === 1 &&
			window.instances.get('second').actions.length === 1
	);
	const actions = await page.evaluate(() =>
		[...window.instances.values()].map((instance) => instance.actions[0])
	);

	assert.equal(actions[0].type, 'continue_conversation');
	assert.equal(actions[0].humanFriendlyMessage, 'Plan my weekend');
	assert.equal(actions[0].params.context.itineraryId, 'TRIP-042');
	assert.equal(actions[0].formName, 'trip');
	assert.equal(actions[0].formState.trip.traveler.value, 'Ada Lovelace');
	assert.equal(actions[1].formState.trip.traveler.value, 'Grace Hopper');
	assert.deepEqual(
		await page.evaluate(() =>
			[...window.instances.values()].map((instance) => instance.trusted[0])
		),
		[true, true]
	);
	const before = page.url();

	await first.getByRole('button', { exact: true, name: 'OpenUI docs' }).click();
	await page.waitForFunction(() => window.instances.get('first').actions.length === 2);
	assert.equal(
		await page.evaluate(() => window.instances.get('first').actions[1].type),
		'open_url'
	);
	assert.equal(page.url(), before);
	assert.equal(await page.evaluate(() => window.instances.get('first').trusted[1]), true);
	await first
		.getByRole('button', { exact: true, name: 'Plan trip' })
		.evaluate((button) => button.click());
	await page.waitForFunction(() => window.instances.get('first').actions.length === 3);
	assert.equal(await page.evaluate(() => window.instances.get('first').trusted[2]), false);
	await page.evaluate(({ source }) => window.mountCard(source, 'markdown-link'), fixtures[6]);
	await page
		.frameLocator('[data-testid="markdown-link"]')
		.getByRole('link', { name: 'Read documentation' })
		.click();
	await page.waitForFunction(() => window.instances.get('markdown-link').actions.length === 1);
	assert.equal(
		await page.evaluate(() => window.instances.get('markdown-link').actions[0].params.url),
		'https://www.openui.com/docs/openui-lang'
	);
	await page.screenshot({ fullPage: true, path: path.join(scratch, 'openui.png') });
	await page.evaluate(() => {
		for (const instance of window.instances.values()) {
			instance.handle.dispose();
			instance.controller.abort();
			instance.host.remove();
		}
	});
	assert.equal(await page.locator('iframe').count(), 0);
	assert.deepEqual(errors, []);
	assert.deepEqual(external, []);
	console.log(
		'OpenUI interactions passed: scoped form actions, repeated occurrences, theme/width retention, links, disposal, and offline assets.'
	);
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(scratch, { force: true, recursive: true });
}
