/* Browser transport for the unchanged native OpenUI runtime. */
(() => {
  'use strict';
  const parameters = new URLSearchParams(location.hash.slice(1));
  const host = window.__picoOpenUIHost;
  const channel = host?.channel ?? parameters.get('channel');
  const id = host?.id ?? parameters.get('id');
  const parentOrigin = host?.parent ?? parameters.get('parent');
  if (!channel || !id || !parentOrigin || window.parent === window) return;

  let userInteraction = false;
  let interactionTimer = 0;
  const rememberInteraction = event => {
    if (!event.isTrusted || (event.type === 'keydown' && !['Enter', ' '].includes(event.key))) return;
    userInteraction = true;
    clearTimeout(interactionTimer);
    interactionTimer = setTimeout(() => { userInteraction = false; }, 0);
  };
  for (const type of ['click', 'auxclick', 'keydown']) document.addEventListener(type, rememberInteraction, true);


  const send = message => {
    if (!message || typeof message !== 'object') return;
    if (message.kind !== 'ready' && message.sourceID !== id) return;
    if (!['ready', 'size', 'action', 'error'].includes(message.kind)) return;
    const userInitiated = message.kind === 'action' && userInteraction;
    if (message.kind === 'action') userInteraction = false;
    window.parent.postMessage({
      namespace: 'pico-openui', version: 1, channel, id,
      kind: message.kind, payload: message.payload, userInitiated,
    }, parentOrigin);
  };

  window.webkit = { messageHandlers: { picoOpenUI: { postMessage: send } } };

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const message = event.data;
    if (!message || message.namespace !== 'pico-openui' || message.version !== 1 ||
        message.channel !== channel || message.id !== id || message.kind !== 'render') return;
    if (typeof message.source !== 'string' || message.source.length > 100000) return;
    window.picoOpenUI?.render({
      source: message.source, sourceID: id,
      colorScheme: message.dark ? 'dark' : 'light', isStreaming: false,
    });
  });
})();
