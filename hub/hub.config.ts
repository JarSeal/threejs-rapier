import type { HubConfig } from '../devTools/hub/types';

/**
 * The Ækasha Hub's site settings (p551). The menu comes from the pages themselves: each page's
 * `aek:menu`, `aek:order` and `aek:icon` (p550 §3.3). The GitHub links are `package.json`'s
 * repository.
 */
const hubConfig: HubConfig = {
  title: 'Ækasha Hub',
  description:
    'Instructions, examples and API documentation for Ækasha, the WebGPU framework built on Three.js, Rapier and its own ECS.',
};

export default hubConfig;
