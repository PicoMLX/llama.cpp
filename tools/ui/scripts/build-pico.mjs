import { publishPicoPackage } from './pico-package.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(scriptDir, '..');
const defaultPicoHtmlDir = resolve(uiDir, '../../../picoserver/PicoServer/HTTP Server/HTML');
const picoHtmlDir = resolve(process.env.PICO_HTML_DIR ?? defaultPicoHtmlDir);

function run(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...options });

		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolvePromise();

				return;
			}

			reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
		});
	});
}

if (!(await stat(picoHtmlDir)).isDirectory()) {
	throw new Error(`Pico HTML directory does not exist: ${picoHtmlDir}`);
}

const buildDir = await mkdtemp(join(tmpdir(), 'llama-ui-pico-'));

try {
	await run('npm', ['run', 'build:vite'], {
		cwd: uiDir,
		env: {
			...process.env,
			LLAMA_UI_BUNDLE_STRATEGY: 'single',
			LLAMA_UI_OUT_DIR: buildDir,
			LLAMA_UI_PICO_BUILD: '1'
		}
	});

	const destination = await publishPicoPackage(buildDir, picoHtmlDir, {
		logoPath: join(uiDir, 'src/lib/assets/logo.svg')
	});

	console.log(`Pico UI written to ${destination}`);
} finally {
	await rm(buildDir, { force: true, recursive: true });
}
