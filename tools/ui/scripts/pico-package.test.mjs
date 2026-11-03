import { publishPicoPackage, validatePicoPackage } from './pico-package.mjs';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

async function write(path, contents) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
}

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'pico-package-test-'));

	t.after(() => rm(root, { force: true, recursive: true }));

	const build = join(root, 'build');
	const html = join(root, 'HTML');
	const logoPath = join(root, 'logo.svg');

	await mkdir(html);
	await writeFile(
		logoPath,
		'<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" /></svg>'
	);
	await write(join(html, 'loading.html'), 'host loading');
	await write(join(html, 'onboarding-download.html'), 'host onboarding');
	await write(
		join(build, 'index.html'),
		`<!doctype html><html><head>
<link rel="manifest" href="manifest.webmanifest">
<link href="favicon.ico" rel="icon">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="stylesheet" href="./_app/immutable/assets/bundle.abc.css">
<link rel="modulepreload" href="./_app/immutable/bundle.abc.js">
</head><body><script>import("./_app/immutable/bundle.abc.js")</script></body></html>`
	);
	await write(join(build, '_app/immutable/bundle.abc.js'), 'window.bootstrap = true;');
	await write(
		join(build, '_app/immutable/assets/bundle.abc.css'),
		'@font-face{src:url("./fonts/test%20font.woff2?v=1#face")} .icon{background:url(data:image/png;base64,AAAA)}'
	);
	await write(
		join(build, '_app/immutable/assets/fonts/test font.woff2'),
		Buffer.from([0, 1, 2, 255])
	);
	await write(join(build, '_app/version.json'), JSON.stringify({ version: 'frontend-123' }));
	await write(join(build, 'build.json'), JSON.stringify({ version: 'pico-123' }));
	await write(join(build, 'locales/en.json'), JSON.stringify({ hello: 'Hello' }));
	await write(join(build, 'locales/es.json'), JSON.stringify({ hello: 'Hola' }));
	await write(
		join(build, 'support/details.html'),
		'<html><body><img src="./picture.svg"></body></html>'
	);
	await write(join(build, 'support/picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

	for (const file of [
		'exa.ico',
		'github-light.png',
		'github-dark.png',
		'context7.png',
		'huggingface.ico'
	]) {
		await write(join(build, 'recommended-mcp', file), Buffer.from([0, 255, 1]));
	}

	return { build, html, logoPath };
}

async function assertHostResources(html) {
	assert.equal(await readFile(join(html, 'loading.html'), 'utf8'), 'host loading');
	assert.equal(await readFile(join(html, 'onboarding-download.html'), 'utf8'), 'host onboarding');
	assert.deepEqual((await readdir(html)).sort(), [
		'loading.html',
		'onboarding-download.html',
		'webui'
	]);
}

test('packages all nested assets and generates icons without PWA build leftovers', async (t) => {
	const { build, html, logoPath } = await fixture(t);
	const destination = await publishPicoPackage(build, html, { logoPath });
	const index = await readFile(join(destination, 'index.html'), 'utf8');

	assert.match(index, /\.\/_app\/immutable\/bundle\.abc\.js/);
	assert.match(index, /\.\/_app\/immutable\/assets\/bundle\.abc\.css/);
	assert.doesNotMatch(index, /rel="(?:manifest|apple-touch-icon)"|favicon\.ico/);
	assert.match(await readFile(join(destination, 'favicon.svg'), 'utf8'), /fill="#111111"/);
	assert.match(await readFile(join(destination, 'favicon-dark.svg'), 'utf8'), /fill="#fafafa"/);
	assert.equal(
		await readFile(join(destination, '_app/immutable/bundle.abc.js'), 'utf8'),
		'window.bootstrap = true;'
	);
	assert.deepEqual(
		await readFile(join(destination, '_app/immutable/assets/fonts/test font.woff2')),
		Buffer.from([0, 1, 2, 255])
	);
	assert.equal(await readFile(join(destination, 'locales/es.json'), 'utf8'), '{"hello":"Hola"}');
	assert.match(
		await readFile(join(destination, 'support/details.html'), 'utf8'),
		/\.\/picture\.svg/
	);
	await validatePicoPackage(destination);
	await assertHostResources(html);
});

test('replaces the complete prior package instead of retaining stale assets', async (t) => {
	const { build, html, logoPath } = await fixture(t);
	const destination = await publishPicoPackage(build, html, { logoPath });

	await write(join(destination, '_app/immutable/stale.js'), 'old asset');
	await write(join(build, '_app/immutable/bundle.abc.js'), 'window.bootstrap = "new";');
	await publishPicoPackage(build, html, { logoPath });

	await assert.rejects(access(join(destination, '_app/immutable/stale.js')));
	assert.equal(
		await readFile(join(destination, '_app/immutable/bundle.abc.js'), 'utf8'),
		'window.bootstrap = "new";'
	);
	await assertHostResources(html);
});

for (const [name, damage] of [
	['missing bootstrap import', async (build) => rm(join(build, '_app/immutable/bundle.abc.js'))],
	[
		'missing nested font',
		async (build) => rm(join(build, '_app/immutable/assets/fonts/test font.woff2'))
	],
	['missing asset in nested HTML', async (build) => rm(join(build, 'support/picture.svg'))],
	[
		'HTML reference outside package',
		async (build) => {
			const index = join(build, 'index.html');

			await writeFile(
				index,
				(await readFile(index, 'utf8')).replace(
					'</head>',
					'<script src="../loading.html"></script></head>'
				)
			);
		}
	]
]) {
	test(`keeps the prior package and cleans staging after ${name}`, async (t) => {
		const { build, html, logoPath } = await fixture(t);
		const destination = await publishPicoPackage(build, html, { logoPath });
		const previousIndex = await readFile(join(destination, 'index.html'), 'utf8');

		await damage(build);
		await assert.rejects(
			publishPicoPackage(build, html, { logoPath }),
			/Missing Pico asset|escapes package/
		);
		assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), previousIndex);
		await validatePicoPackage(destination);
		await assertHostResources(html);
	});
}

test('does not overwrite an existing non-directory destination', async (t) => {
	const { build, html, logoPath } = await fixture(t);

	await writeFile(join(html, 'webui'), 'keep this file');
	await assert.rejects(publishPicoPackage(build, html, { logoPath }), /not a directory/);
	assert.equal(await readFile(join(html, 'webui'), 'utf8'), 'keep this file');
	assert.deepEqual((await readdir(html)).sort(), [
		'loading.html',
		'onboarding-download.html',
		'webui'
	]);
});
