import {
  HUB_API_REBUILDING_PAGE,
  HUB_API_REBUILDING_STATUS,
  HUB_DEV_EVENT,
  HUB_DEV_META,
  type HubDevEvent,
} from '../../../devTools/hub/devProtocol';

/**
 * The Hub's dev client (p551 Phase 2): in dev builds only, as `_assets/hub-dev.js`. It refreshes
 * the page when the dev plugin (`devTools/hubPlugin.ts`) rebuilt something it shows.
 *
 * It opens its own socket to the dev server's HMR WebSocket and reads only `aek:hub`, instead of
 * importing `/@vite/client`: that one obeys every `full-reload` (the scene gatherer sends one per
 * gather) and shows the app's error overlay, so the Hub would reload on every scene save.
 */

const POLL_MS = 1000;

const socketPath = document.querySelector<HTMLMetaElement>(`meta[name="${HUB_DEV_META}"]`)?.content;
const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${socketPath}`;
const pagePath = document.body.dataset.hubPage ?? '';
/** Served for an API page while the API docs rebuild (p553 §2.5), at that page's URL */
const isApiRebuildingPage = pagePath === HUB_API_REBUILDING_PAGE;

/** The stylesheet at its new version, the old one removed once the new one has loaded */
const swapStyles = (version: string) => {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const url = new URL(link.href);
    if (!url.pathname.endsWith('/_assets/hub.css')) continue;
    url.searchParams.set('v', version);
    const next = link.cloneNode() as HTMLLinkElement;
    next.href = url.href;
    next.addEventListener('load', () => link.remove(), { once: true });
    next.addEventListener('error', () => next.remove(), { once: true });
    link.after(next);
  }
};

const handleEvent = (event: HubDevEvent) => {
  if (event.kind === 'api') {
    if (isApiRebuildingPage) location.reload();
  } else if (event.kind === 'css') swapStyles(event.version);
  // The 404 page reloads on any page change: the page it stands in for may exist now
  else if (event.kind === 'all' || pagePath === '404' || event.paths.includes(pagePath)) {
    location.reload();
  }
};

/** Vite's own wait for a restarted server: a `vite-ping` socket opens once it's back */
const reloadWhenServerIsBack = () => {
  const ping = () => {
    const socket = new WebSocket(socketUrl, 'vite-ping');
    socket.addEventListener('open', () => location.reload(), { once: true });
    socket.addEventListener('error', () => setTimeout(ping, POLL_MS), { once: true });
  };
  ping();
};

const connect = () => {
  const socket = new WebSocket(socketUrl, 'vite-hmr');
  let isOpen = false;
  socket.addEventListener('open', () => {
    isOpen = true;
    // The rebuild may have ended before the socket opened: its `api` event is gone then
    if (isApiRebuildingPage) {
      void fetch(location.href, { method: 'HEAD', cache: 'no-store' }).then(
        (res) => res.status !== HUB_API_REBUILDING_STATUS && location.reload(),
        () => {} // The server is gone: the close handler waits for it
      );
    }
  });
  socket.addEventListener('message', ({ data }) => {
    try {
      const message = JSON.parse(String(data)) as { type?: string; event?: string; data?: unknown };
      if (message.type === 'custom' && message.event === HUB_DEV_EVENT) {
        handleEvent(message.data as HubDevEvent);
      }
    } catch {
      // Not a message of ours
    }
  });
  // A restart (a devTools/ or hub.config.ts change) makes a new token: reload for it
  socket.addEventListener('close', () => isOpen && reloadWhenServerIsBack());
};

// The plugin leaves the path empty when the dev server has no WebSocket (`server.ws: false`)
if (socketPath) connect();
