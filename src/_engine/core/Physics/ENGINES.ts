import type Rapier from '@dimforge/rapier3d-compat';

import * as RapierAPI from './EngineRapier';
import { EngineAPIType } from './PhysicsAPITypes';

// Define the engines (key) and their init functions
export const ENGINES: Record<
  string,
  {
    init: () => Promise<unknown>;
    forceTypeEngine: (engineObj: unknown) => unknown;
    engineAPI: EngineAPIType;
  }
> = {
  RAPIER: {
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
