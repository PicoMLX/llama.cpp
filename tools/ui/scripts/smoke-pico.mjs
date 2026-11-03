import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(process.env.PICO_WEB_ROOT ?? resolve(uiDir, 'dist'));
const originalFixture = await readFile(
	resolve(uiDir, 'tests/unit/fixtures/open-responses/pico-completed-response.sse'),
	'utf8'
);
const cardKinds = (process.env.PICO_SMOKE_CARDS ?? '').split(',').filter(Boolean);
const cardSources = {
	'html-preview':
		'<section style="padding:20px"><h2>Packaged HTML</h2><p>Local static preview</p></section>',
	openui:
		'root = Stack([TextContent("Packaged OpenUI"), Button("Continue packaging", @ToAssistant("Continue packaging", {viewId: "packaging-smoke"}), "primary")])',
	'vega-lite': JSON.stringify({
		data: {
			values: [
				{ category: 'A', value: 2 },
				{ category: 'B', value: 5 }
			]
		},
		encoding: {
			x: { field: 'category', type: 'nominal' },
			y: { field: 'value', type: 'quantitative' }
		},
		mark: 'bar',
		title: 'Packaged chart'
	})
};
const diagramSources =
	process.env.PICO_SMOKE_DIAGRAMS === '1'
		? JSON.parse(
				await readFile(
					resolve(uiDir, 'tests/fixtures/pico-cards/pele-native-examples.json'),
					'utf8'
				)
			)
				.filter(({ family }) => ['usecase', 'agentflow'].includes(family))
				.filter(
					(value, index, all) =>
						all.findIndex((candidate) => candidate.family === value.family) === index
				)
				.map(({ source }) => source)
		: [];
const reply =
	"Because they don't have the guts!" +
	cardKinds
		.map((kind) => {
			assert.ok(cardSources[kind], `Unknown card ${kind}`);

			return `\n\n\`\`\`${kind}\n${cardSources[kind]}\n\`\`\``;
		})
		.join('') +
	diagramSources.map((source) => `\n\n\`\`\`mermaid\n${source}\n\`\`\``).join('');
const fixture = originalFixture.replaceAll(
	"Because they don't have the guts!",
	JSON.stringify(reply).slice(1, -1)
);
const lanHTTP = process.env.PICO_SMOKE_LAN === '1';
const token = 'pico-packaging-smoke';
const requests = [];
const pageErrors = [];
const missingAssets = [];
const statuses = new Map([
	['smoke/test-4bit', 'loaded'],
	['smoke/second-4bit', 'unloaded']
]);

let mode = 'model';

function props(model = 'smoke/test-4bit') {
	return {
		bos_token: '',
		build_info: 'Pico packaging smoke',
		chat_template: '{% for message in messages %}{{ message.content }}{% endfor %}',
		default_generation_settings: {
			id: 0,
			id_task: -1,
			is_processing: false,
			n_ctx: 4096,
			params: { n_predict: -1, samplers: ['temperature'], temperature: 0.8 },
			speculative: false
		},
		eos_token: '',
		modalities: { audio: false, vision: false },
		model_alias: model,
		model_path: model,
		role: mode,
		server_name: 'Pico packaging smoke',
		total_slots: 1
	};
}

const mime = {
	'.css': 'text/css',
	'.html': 'text/html',
	'.ico': 'image/x-icon',
	'.js': 'application/javascript',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};
const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, 'http://localhost');

	let body = '';

	for await (const chunk of request) body += chunk;
	const record = {
		auth: request.headers.authorization,
		body: body ? JSON.parse(body) : null,
		method: request.method,
		path: url.pathname
	};

	requests.push(record);
	const json = (data, status = 200) => {
		response.writeHead(status, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify(data));
	};

	if (url.pathname === '/props') {
		if (record.auth !== `Bearer ${token}`) return json({ error: 'Invalid API key' }, 401);

		return json(props(url.searchParams.get('model') ?? undefined));
	}

	if (url.pathname === '/v1/models') {
		const data = [...statuses].map(([id, status]) => ({
			created: 0,
			id,
			object: 'model',
			owned_by: 'Pico AI Server',
			status: { value: status }
		}));

		return json({ data, models: data.map(({ id }) => ({ model: id, name: id })), object: 'list' });
	}

	if (url.pathname === '/models/load' || url.pathname === '/models/unload') {
		assert.equal(record.auth, `Bearer ${token}`);
		const status = url.pathname.endsWith('/load') ? 'loaded' : 'unloaded';

		statuses.set(record.body.model, status);

		return json({ model: record.body.model, status: { value: status } });
	}

	if (url.pathname === '/v1/responses') {
		assert.equal(record.auth, `Bearer ${token}`);
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });

		return response.end(fixture);
	}

	if (url.pathname.startsWith('/v1/') || url.pathname === '/tools') {
		return json({ error: 'Unsupported mock endpoint' }, 404);
	}

	const path = resolve(
		webRoot,
		`.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`
	);

	if (!path.startsWith(`${webRoot}${sep}`)) return json({ error: 'Invalid path' }, 400);

	try {
		const content = await readFile(path);

		response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
		response.end(content);
	} catch {
		missingAssets.push(url.pathname);
		json({ error: 'Missing static asset' }, 404);
	}
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://${lanHTTP ? 'pico.test' : '127.0.0.1'}:${server.address().port}`;

let browser;

try {
	browser = await chromium.launch({
		channel: process.env.PICO_BROWSER_CHANNEL,
		headless: true,
		...(lanHTTP
			? { args: ['--host-resolver-rules=MAP pico.test 127.0.0.1', '--no-proxy-server'] }
			: {})
	});
	for (const suffix of ['/#?apikey=', '/#/?apikey=', '/?apikey=']) {
		const context = await browser.newContext({
			locale: 'en-US',
			viewport: { height: 1000, width: 1440 }
		});
		const page = await context.newPage();
		const first = requests.length;

		page.on('pageerror', (error) => pageErrors.push(String(error)));
		await page.goto(`${origin}${suffix}${token}`, { waitUntil: 'networkidle' });

		if (lanHTTP) {
			assert.equal(await page.evaluate(() => window.isSecureContext), false);
			assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
		}

		await page.locator('textarea:visible,[contenteditable="true"]:visible').first().waitFor();
		assert.equal(
			requests.slice(first).find(({ path }) => path === '/props')?.auth,
			`Bearer ${token}`
		);
		assert.ok(!page.url().includes('apikey='), 'Invite key must be removed after navigation');

		if (suffix === '/#/?apikey=') {
			await page
				.locator('textarea:visible,[contenteditable="true"]:visible')
				.first()
				.fill('Tell a joke.');
			await page.getByRole('button', { exact: true, name: 'Send' }).click();
			await page.getByText("Because they don't have the guts!", { exact: true }).waitFor();
			for (const kind of cardKinds) {
				const card = page.locator(`[data-pico-card="${kind}"]`);

				if (kind === 'vega-lite')
					await card.locator('.pico-card-render svg').waitFor({ timeout: 15000 });
				else if (kind === 'html-preview')
					await card
						.frameLocator('iframe')
						.getByText('Packaged HTML', { exact: true })
						.waitFor({ timeout: 15000 });
				else
					await card
						.frameLocator('iframe')
						.getByText('Packaged OpenUI', { exact: true })
						.waitFor({ timeout: 15000 });

				if (kind === 'openui') {
					const continuation = page.waitForRequest(
						(request) =>
							new URL(request.url()).pathname === '/v1/responses' &&
							Boolean(request.postData()?.includes('Continue packaging'))
					);

					await card
						.frameLocator('iframe')
						.getByRole('button', { exact: true, name: 'Continue packaging' })
						.click();
					const request = await continuation;

					assert.ok(
						request.postData()?.includes('packaging-smoke'),
						'OpenUI action context must reach Responses'
					);
				}
			}
			for (let index = 0; index < diagramSources.length; index++)
				await page.locator('pre.mermaid svg').nth(index).waitFor({ timeout: 15000 });
		}

		await context.close();
	}

	mode = 'router';
	const context = await browser.newContext({ viewport: { height: 1000, width: 1440 } });
	const page = await context.newPage();

	page.on('pageerror', (error) => pageErrors.push(String(error)));
	await page.goto(`${origin}/#?apikey=${token}`, { waitUntil: 'networkidle' });
	await page.locator('button[aria-label="Expand navigation"]').click();
	await page
		.getByRole('button', { name: /^Models/ })
		.first()
		.click();
	await page.getByText('smoke/second-4bit', { exact: true }).hover();
	await page.getByTitle('Load model', { exact: true }).first().click();
	await page.getByText('smoke/test-4bit', { exact: true }).hover();
	await page.getByTitle('Unload model', { exact: true }).first().click();
	await page.getByRole('button', { exact: true, name: 'Model actions' }).first().click();
	assert.ok(
		!(await page.getByRole('menuitem').allTextContents()).some((text) =>
			/delete|download/i.test(text)
		)
	);
	assert.ok(requests.some(({ path }) => path === '/models/load'));
	assert.ok(requests.some(({ path }) => path === '/models/unload'));
	assert.ok(!requests.some(({ path }) => path === '/models/sse'));
	const accessContext = await browser.newContext({ locale: 'en-US' });
	const accessPage = await accessContext.newPage();

	await accessPage.goto(origin, { waitUntil: 'networkidle' });
	const accessKey = accessPage.getByLabel('Access Key', { exact: true });

	await accessKey.waitFor();
	assert.equal(await accessPage.title(), 'Connect to Pico');
	assert.equal(await accessPage.getByRole('alert').count(), 0);
	await accessKey.fill('incorrect-key');
	await accessPage.getByRole('button', { exact: true, name: 'Connect' }).click();
	await accessPage.getByRole('alert').waitFor();
	await accessKey.fill(token);
	await accessPage.getByRole('button', { exact: true, name: 'Connect' }).click();
	await accessPage.locator('textarea:visible,[contenteditable="true"]:visible').first().waitFor();
	assert.equal(await accessPage.title(), 'Pico');
	await accessContext.close();

	const translatedContext = await browser.newContext({ locale: 'nl' });
	const translatedPage = await translatedContext.newPage();

	await translatedPage.goto(origin, { waitUntil: 'networkidle' });
	await translatedPage.getByRole('heading', { name: 'Verbinden met Pico' }).waitFor();
	await translatedContext.close();
	assert.deepEqual(pageErrors, []);
	assert.deepEqual(missingAssets, []);
	console.log(
		`Pico packaged UI smoke passed (${lanHTTP ? 'LAN HTTP' : 'loopback'}): assets, invite authentication, Responses, model lifecycle.`
	);
} finally {
	await browser?.close();
	await new Promise((done) => server.close(done));
}
