import type { PicoCardContext, PicoCardHandle } from '../../types';

// Runs only in the opaque preview frame, whose CSP denies author scripts and resources.
function htmlRuntime() {
	const tags = new Set(
		'a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i ins kbd li main mark nav ol p pre q s samp section small span strong sub sup table tbody td tfoot th thead time tr u ul var wbr'.split(
			' '
		)
	);
	const attributes = new Set([
		'class',
		'id',
		'title',
		'lang',
		'dir',
		'style',
		'role',
		'aria-label'
	]);

	let channel = '';
	let sourceID = '';
	let scheduled = false;

	const theme = document.createElement('style');

	document.head.append(theme);
	const send = (type: string, detail: Record<string, unknown> = {}) =>
		parent.postMessage({ channel, sourceID, type, ...detail }, '*');
	const motion = (style: CSSStyleDeclaration) => {
		for (const name of Array.from(style)) {
			if (/^(animation|transition)(-|$)/i.test(name) || name === 'scroll-behavior')
				style.removeProperty(name);
		}
	};
	const stripRules = (rules: CSSRuleList) => {
		for (const rule of Array.from(rules)) {
			if ('style' in rule) motion((rule as CSSStyleRule).style);

			if ('cssRules' in rule) stripRules((rule as CSSGroupingRule).cssRules);
		}
	};
	const measure = () => {
		if (scheduled) return;

		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			const body = document.body;
			const bodyBounds = body.getBoundingClientRect();
			const bodyStyle = getComputedStyle(body);
			const outerBottom = Math.max(0, parseFloat(bodyStyle.marginBottom) || 0);
			const trailingSpacing =
				(parseFloat(bodyStyle.paddingBottom) || 0) + (parseFloat(bodyStyle.borderBottomWidth) || 0);
			const flowBottom = Math.max(0, bodyBounds.bottom + window.scrollY);
			const overflowBottom =
				bodyBounds.top +
				window.scrollY +
				(parseFloat(bodyStyle.borderTopWidth) || 0) +
				body.scrollHeight;

			// Root scrollHeight has a viewport floor, so it cannot track shrinking previews.
			let height = Math.max(flowBottom, overflowBottom);

			const outsideWidth = (rect: DOMRect) =>
				rect.left + window.scrollX < -1 || rect.right + window.scrollX > window.innerWidth + 1;
			const transformed = (style: CSSStyleDeclaration) =>
				['transform', 'translate', 'rotate', 'scale'].some(
					(property) =>
						style.getPropertyValue(property) && style.getPropertyValue(property) !== 'none'
				);
			const unsupportedPseudo = (element: Element) =>
				['::before', '::after'].some((selector) => {
					const style = getComputedStyle(element, selector);
					const active =
						style.content !== 'none' &&
						style.content !== 'normal' &&
						style.display !== 'none' &&
						!['hidden', 'collapse'].includes(style.visibility);

					return (
						active &&
						(element === document.documentElement ||
							style.position !== 'static' ||
							transformed(style))
					);
				});

			let unsupported =
				bodyStyle.position === 'fixed' ||
				bodyBounds.top + window.scrollY < 0 ||
				outsideWidth(bodyBounds) ||
				body.scrollWidth > window.innerWidth + 1 ||
				(body.scrollHeight > body.clientHeight + 1 && transformed(bodyStyle));

			const suppressed = new Set<Element>();

			for (const element of [document.documentElement, body, ...body.querySelectorAll('*')]) {
				const style = element === body ? bodyStyle : getComputedStyle(element);

				if (
					style.display === 'none' ||
					(element.parentElement && suppressed.has(element.parentElement))
				) {
					suppressed.add(element);

					continue;
				}

				if (unsupportedPseudo(element)) unsupported = true;

				if (element === document.documentElement || element === body) continue;

				const bounds = element.getBoundingClientRect();

				if (bounds.width <= 0 || bounds.height <= 0 || style.visibility === 'hidden') continue;

				if (
					flowBottom === 0 ||
					style.position === 'fixed' ||
					bounds.top + window.scrollY < 0 ||
					outsideWidth(bounds)
				)
					unsupported = true;

				height = Math.max(height, bounds.bottom + window.scrollY + trailingSpacing);
			}

			height = Math.ceil(height + outerBottom);

			if (!Number.isFinite(height) || height > 4096 || unsupported)
				send('error', { message: 'HTML preview exceeds the static layout limits' });
			else
				send('size', {
					height: Math.max(1, height),
					text: document.body.textContent?.slice(0, 16384)
				});
		});
	};
	const applyTheme = (dark: boolean) => {
		theme.textContent = `html{color-scheme:${dark ? 'dark' : 'light'}}body{display:flow-root;margin:0;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:${dark ? '#fafafa' : '#111'};background:transparent;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{max-width:100%}th,td{overflow-wrap:anywhere}`;
	};
	const safeAttributes = (source: Element, destination: Element) => {
		for (const { name, value } of Array.from(source.attributes)) {
			if (attributes.has(name)) {
				if (name !== 'dir' || /^(ltr|rtl|auto)$/i.test(value))
					destination.setAttribute(name, value);
			} else if (source.tagName === 'OL' && name === 'reversed') destination.setAttribute(name, '');
			else if (
				/^(TD|TH)$/.test(source.tagName) &&
				/^(colspan|rowspan)$/.test(name) &&
				/^\d+$/.test(value) &&
				+value >= 1 &&
				+value <= 100
			)
				destination.setAttribute(name, value);
			else if (
				((source.tagName === 'OL' && name === 'start') ||
					(source.tagName === 'LI' && name === 'value')) &&
				/^-?\d+$/.test(value) &&
				Math.abs(+value) <= 10000
			)
				destination.setAttribute(name, value);
		}

		if (destination instanceof HTMLElement) motion(destination.style);
	};
	const render = (source: string) => {
		if (
			new TextEncoder().encode(source).length > 131072 ||
			source.includes('\0') ||
			/<!ENTITY/i.test(source)
		)
			throw new Error('HTML preview source is unsupported or too large');

		const parsed = new DOMParser().parseFromString(source, 'text/html');

		let count = 0;

		const validate = (node: Node, depth: number) => {
			if (++count > 4096 || depth > 64) throw new Error('HTML preview is too complex');

			for (const child of Array.from(node.childNodes)) validate(child, depth + 1);
		};

		validate(parsed.documentElement, 0);

		const styles: HTMLStyleElement[] = [];
		const build = (node: Node, depth: number): Node | null => {
			if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? '');

			if (!(node instanceof Element)) return null;

			const name = node.tagName.toLowerCase();

			if (name === 'style') {
				const type = node.getAttribute('type');

				if (!type || type.toLowerCase() === 'text/css') {
					const style = document.createElement('style');

					style.textContent = node.textContent;

					if (node.hasAttribute('media')) style.setAttribute('media', node.getAttribute('media')!);

					styles.push(style);
				}

				return null;
			}

			if (node.hasAttribute('hidden')) {
				if (tags.has(name)) {
					for (const style of Array.from(node.querySelectorAll('style'))) build(style, depth + 1);
				}

				return null;
			}

			if (name === 'img')
				return document.createTextNode(
					`[Image${node.getAttribute('alt') ? `: ${node.getAttribute('alt')}` : ' omitted'}]`
				);

			if (!tags.has(name)) return null;

			const element = document.createElement(name);

			safeAttributes(node, element);
			for (const child of Array.from(node.childNodes)) {
				const clean = build(child, depth + 1);

				if (clean) element.append(clean);
			}

			return element;
		};

		for (const style of Array.from(parsed.head.querySelectorAll('style'))) build(style, 0);
		const fragment = document.createDocumentFragment();

		for (const child of Array.from(parsed.body.childNodes)) {
			const clean = build(child, 0);

			if (clean) fragment.append(clean);
		}

		if (!fragment.textContent?.trim() && !fragment.querySelector('*'))
			throw new Error('HTML preview is empty');

		safeAttributes(parsed.body, document.body);
		for (const name of ['class', 'id', 'lang', 'dir']) {
			if (parsed.documentElement.hasAttribute(name))
				document.documentElement.setAttribute(name, parsed.documentElement.getAttribute(name)!);
		}
		document.body.replaceChildren(fragment);
		document.head.append(...styles);
		for (const style of styles) {
			if (style.sheet) stripRules(style.sheet.cssRules);
		}
		const staticStyle = document.createElement('style');

		staticStyle.textContent =
			'*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
		document.head.append(staticStyle);
		new ResizeObserver(measure).observe(document.body, { box: 'border-box' });
		measure();
		document.fonts.ready.then(measure);
	};

	window.addEventListener('message', (event) => {
		if (event.source !== parent || event.data?.channel !== channel) return;

		try {
			if (event.data.type === 'render') {
				sourceID = event.data.sourceID;
				applyTheme(Boolean(event.data.dark));
				render(event.data.source);
			} else if (event.data.type === 'theme') {
				applyTheme(Boolean(event.data.dark));
				measure();
			}
		} catch (error) {
			send('error', { message: String(error) });
		}
	});
	channel = location.hash.slice(1);
	for (const event of [
		'pointerover',
		'pointerout',
		'pointerdown',
		'pointerup',
		'pointercancel',
		'focusin',
		'focusout',
		'keydown',
		'keyup'
	])
		document.addEventListener(event, measure, true);
	for (const event of ['resize', 'focus', 'blur']) window.addEventListener(event, measure);
	send('ready');
}

function secureToken(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export async function renderHtmlPreview(
	host: HTMLElement,
	source: string,
	context: PicoCardContext
): Promise<PicoCardHandle> {
	const channel = secureToken();
	const nonce = secureToken();
	const frame = document.createElement('iframe');

	frame.title = 'HTML preview';
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.setAttribute('credentialless', '');
	frame.referrerPolicy = 'no-referrer';
	frame.style.cssText = 'display:block;width:100%;height:1px;border:0;background:transparent';
	// The channel is provided as a trusted literal; author source is sent only as data.
	const runtime = htmlRuntime.toString().replace('location.hash.slice(1)', JSON.stringify(channel));

	frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"></head><body><script nonce="${nonce}">(${runtime})();</script></body></html>`;
	let timer: ReturnType<typeof setTimeout>;
	let settled = false;
	let rejectPending: (error: Error) => void = () => {};

	const dispose = () => {
		clearTimeout(timer);
		window.removeEventListener('message', receive);
		context.signal.removeEventListener('abort', abort);
		frame.remove();
	};
	const abort = () => {
		dispose();

		if (!settled) rejectPending(new DOMException('Card removed', 'AbortError'));
	};

	let receive: (event: MessageEvent) => void;

	await new Promise<void>((resolve, reject) => {
		rejectPending = reject;
		timer = setTimeout(() => {
			dispose();
			reject(new Error('HTML preview timed out'));
		}, 10000);
		receive = (event) => {
			if (event.source !== frame.contentWindow || event.data?.channel !== channel) return;

			if (event.data.type === 'ready')
				frame.contentWindow?.postMessage(
					{ channel, dark: context.dark, source, sourceID: context.id, type: 'render' },
					'*'
				);

			if (event.data.type === 'size' && event.data.sourceID === context.id) {
				const height = Number(event.data.height);

				if (!Number.isFinite(height) || height < 1 || height > 4096) return;

				frame.style.height = `${height}px`;
				frame.title = `HTML preview: ${String(event.data.text ?? '')
					.trim()
					.slice(0, 180)}`;
				settled = true;
				clearTimeout(timer);
				resolve();
			}

			if (event.data.type === 'error') {
				if (!settled) {
					dispose();
					reject(new Error(String(event.data.message)));
				} else
					host.dispatchEvent(
						new CustomEvent('pico-card-error', { detail: String(event.data.message) })
					);
			}
		};
		window.addEventListener('message', receive);
		context.signal.addEventListener('abort', abort, { once: true });

		if (context.signal.aborted) abort();
		else host.append(frame);
	});

	return {
		dispose,
		update(next) {
			frame.contentWindow?.postMessage({ channel, dark: next.dark, type: 'theme' }, '*');
		}
	};
}
