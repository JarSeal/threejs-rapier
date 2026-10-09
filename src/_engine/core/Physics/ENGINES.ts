import type Rapier from '@dimforge/rapier3d-compat';

import * as RapierAPI from './EngineRapier';
import type { EngineAPIType } from './PhysicsAPITypes';

// Define the engines (key) and their init functions
export const ENGINES: Record<
  string,
  {
    /** Display name (eg. in the About dialog) */
    name: string;
    /** The engine's npm package, whose version package.json pins */
    packageName: string;
    init: () => Promise<unknown>;
    forceTypeEngine: (engineObj: unknown) => unknown;
    engineAPI: EngineAPIType;
  }
> = {
  RAPIER: {
    name: 'Rapier',
    packageName: '@dimforge/rapier3d-compat',
    init: async () => {
      const mod = await import('@dimforge/rapier3d-compat');
      const RAPIER = mod.default;
      await RAPIER.init();
      return RAPIER as typeof Rapier;
    },
    forceTypeEngine: (engineObj: unknown) => engineObj as typeof Rapier,
    engineAPI: RapierAPI,
  },
};
