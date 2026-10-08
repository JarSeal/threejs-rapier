// No imports: the Hub's dev client (`hub/_assets/ts/_devClient.ts`) imports this, and
// `hub/tsconfig.json` checks it without Node's types.

/**
 * What the dev plugin (`devTools/hubPlugin.ts`) and the Hub's dev client share (p551 Phase 2).
 * The plugin sends `HubDevEvent`s as the custom HMR event `aek:hub` after a rebuild that changed
 * something; the client listens on the dev server's HMR WebSocket for that event only.
 */

export const HUB_DEV_EVENT = 'aek:hub';

/** The `<meta name>` carrying the HMR WebSocket's path and token (`/?token=…`) */
export const HUB_DEV_META = 'aek-hub-dev';

/**
 * What a dev build writes in that meta's `content`: the plugin puts the path and token in when it
 * serves the page, so the token (new on every server start) is never on disk
 */
export const HUB_DEV_SOCKET_PLACEHOLDER = '%AEK_HUB_DEV_SOCKET%';

export type HubDevEvent =
  /** Only the stylesheet changed: the client swaps it to `?v=<version>` without a reload */
  | { kind: 'css'; version: string }
  /** These pages' HTML changed (site paths, '' the homepage, '404'): open ones reload */
  | { kind: 'pages'; paths: string[] }
  /** The scripts or the static assets changed: every open page reloads */
  | { kind: 'all' };
