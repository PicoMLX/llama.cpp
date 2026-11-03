import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = process.argv[2];

if (!sourceDirectory)
	throw new Error('Pass the native PicoOpenUIRuntime/Resources/OpenUI directory.');

const output = fileURLToPath(
	new URL('../../../../../static/pico-runtime/openui/', import.meta.url)
);
const manifest = JSON.parse(await readFile(resolve(sourceDirectory, 'BuildInfo.json'), 'utf8'));

await mkdir(output, { recursive: true });
await rm(resolve(output, 'fonts'), { force: true, recursive: true });
for (const name of [
	'app.js',
	'app.js.LEGAL.txt',
	'app.css',
	'fonts',
	'Versions.json',
	'BuildInfo.json',
	'THIRD_PARTY_NOTICES.txt'
]) {
	await cp(resolve(sourceDirectory, name), resolve(output, name), { recursive: true });
}
const css = await readFile(resolve(output, 'app.css'), 'utf8');

let browserCSS = css;

for (const match of css.matchAll(/url\(["']?(\.\/fonts\/[^)"']+)["']?\)/g)) {
	const name = match[1];
	const bytes = await readFile(resolve(output, name));
	const mime = name.endsWith('.woff2')
		? 'font/woff2'
		: name.endsWith('.woff')
			? 'font/woff'
			: 'font/ttf';

	browserCSS = browserCSS.replaceAll(
		match[0],
		`url("data:${mime};base64,${bytes.toString('base64')}")`
	);
}
await writeFile(resolve(output, 'browser.css'), browserCSS);
await writeFile(
	resolve(output, 'BrowserBuildInfo.json'),
	JSON.stringify(
		{
			adapter: 'browser-host.js',
			note: 'Official app.js, app.css, fonts and notices are unchanged. browser.css inlines fonts for the opaque sandbox origin.',
			source: 'PicoMarkdownView/PicoOpenUIRuntime/Resources/OpenUI',
			stylesheet: {
				bytes: Buffer.byteLength(browserCSS),
				file: 'browser.css',
				sha256: createHash('sha256').update(browserCSS).digest('hex')
			},
			versions: manifest.versions
		},
		null,
		2
	) + '\n'
);
