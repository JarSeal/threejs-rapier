import { _setEnvBakeHooks } from '../../SkyBox/SkyEnvironment';
import { createBakeStats } from './_dbg__BakeStats';

/** Env bake stats (debug only), shown in the Environment folder (see _dbg__BakeStats.ts). */
const envBakeStats = createBakeStats();
_setEnvBakeHooks(envBakeStats.hooks);

/** What the Environment folder's read-only bindings poll. */
export const envBakeStatsView = envBakeStats.view;
