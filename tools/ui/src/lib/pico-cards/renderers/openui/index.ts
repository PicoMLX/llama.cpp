import type { PicoCardContext, PicoCardHandle } from '../../types';
import { normalizeOpenUIAction } from './action';
import { base } from '$app/paths';

const RENDER_TIMEOUT_MS = 15_000;
const MAX_HEIGHT = 20_000;

let runtimeAssets: Promise<[string, string, string]> | null = null;

function loadRuntime(): Promise<[string, string, string]> {
	if (!runtimeAssets) {
		runtimeAssets = Promise.all(
			['browser.css', 'browser-host.js', 'app.js'].map(async (name) => {
				const response = await fetch(`${base}/pico-runtime/openui/${name}`, {
					credentials: 'omit'
				});

				if (!response.ok) throw new Error('OpenUI runtime could not be loaded.');

				return response.text();
			})
		) as Promise<[string, string, string]>;
		runtimeAssets.catch(() => {
			runtimeAssets = null;
		});
	}

	return runtimeAssets;
}

function runtimeDocument(assets: [string, string, string], channel: string, id: string): string {
	const [css, bridge, app] = assets;
	const host = JSON.stringify({ channel, id, parent: window.location.origin }).replaceAll(
		'<',
		'\\u003c'
	);
	const script = (value: string) => value.replace(/<\/script/gi, '<\\/script');

	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${channel}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>OpenUI content</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><main id="root" aria-label="Interactive OpenUI content"></main>
<script nonce="${channel}">window.__picoOpenUIHost = ${host};${script(bridge)}</script><script nonce="${channel}">${script(app)}</script></body></html>`;
}

export async function renderOpenUI(
	host: HTMLElement,
	source: string,
	context: PicoCardContext
): Promise<PicoCardHandle> {
	if (source.length > 100_000) throw new Error('OpenUI source exceeds the supported length.');

	if (context.signal.aborted) throw new DOMException('OpenUI render cancelled.', 'AbortError');

	const id = context.id;
	const channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	const iframe = document.createElement('iframe');

	iframe.title = 'Interactive OpenUI content';
	iframe.className = 'pico-openui-frame';
	iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
	iframe.setAttribute('credentialless', '');
	iframe.referrerPolicy = 'no-referrer';
	iframe.style.cssText =
		'display:block;border:0;max-width:100%;height:200px;background:transparent';

	return new Promise<PicoCardHandle>((resolve, reject) => {
		let current = context;
		let signal = context.signal;
		let ready = false;
		let settled = false;
		let disposed = false;

		const timer = setTimeout(() => fail(new Error('OpenUI preview timed out.')), RENDER_TIMEOUT_MS);

		function cleanup() {
			clearTimeout(timer);
			window.removeEventListener('message', receive);
			signal.removeEventListener('abort', abort);
			iframe.remove();
			disposed = true;
		}

		function fail(error: Error) {
			if (disposed) return;

			if (!settled) {
				settled = true;
				reject(error);
			} else {
				host.dispatchEvent(new CustomEvent('pico-card-error', { bubbles: true, detail: error }));
			}

			cleanup();
		}

		function abort() {
			if (settled) cleanup();
			else fail(new DOMException('OpenUI render cancelled.', 'AbortError'));
		}

		function sendRender() {
			iframe.style.width = `${Math.max(1, current.width)}px`;

			if (!ready || disposed) return;

			iframe.contentWindow?.postMessage(
				{
					channel,
					dark: current.dark,
					id,
					kind: 'render',
					namespace: 'pico-openui',
					source,
					version: 1
				},
				'*'
			);
		}

		const handle: PicoCardHandle = {
			dispose: cleanup,
			update(next) {
				if (disposed) return;

				if (next.id !== id) throw new Error('OpenUI occurrence identity changed.');

				if (signal !== next.signal) {
					signal.removeEventListener('abort', abort);
					signal = next.signal;
					signal.addEventListener('abort', abort, { once: true });
				}

				current = next;

				if (signal.aborted) abort();
				else sendRender();
			}
		};

		function receive(event: MessageEvent) {
			if (disposed || event.source !== iframe.contentWindow || event.origin !== 'null') return;

			const message = event.data;

			if (
				!message ||
				message.namespace !== 'pico-openui' ||
				message.version !== 1 ||
				message.channel !== channel ||
				message.id !== id
			)
				return;

			if (message.kind === 'ready') {
				ready = true;
				sendRender();
			} else if (message.kind === 'size') {
				const height = message.payload?.height;

				if (
					typeof height !== 'number' ||
					!Number.isFinite(height) ||
					height <= 0 ||
					height > MAX_HEIGHT
				) {
					fail(new Error('OpenUI preview exceeds the supported height.'));

					return;
				}

				iframe.style.height = `${Math.ceil(height)}px`;

				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(handle);
				}
			} else if (
				message.kind === 'error' &&
				Array.isArray(message.payload) &&
				message.payload.length > 0
			) {
				fail(new Error('OpenUI content could not be rendered.'));
			} else if (message.kind === 'action' && settled) {
				const action = normalizeOpenUIAction(
					message.payload,
					message.userInitiated === true && event.isTrusted
				);

				if (action) current.onAction?.(action);
			}
		}

		signal.addEventListener('abort', abort, { once: true });
		window.addEventListener('message', receive);
		sendRender();
		host.append(iframe);
		void loadRuntime().then(
			(assets) => {
				if (!disposed) iframe.srcdoc = runtimeDocument(assets, channel, id);
			},
			() => fail(new Error('OpenUI runtime could not be loaded.'))
		);
	});
}
