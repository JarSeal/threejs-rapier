import { estimateTextureVramBytes, estimateVramBytes, getResultFigures } from './generated';
import { formatBytes } from './report';
import type { PipelineRunResult } from './run';
import type { BudgetLimit } from './settings';

/**
 * Asset budgets (p300 Phase 4 step 1). An optimized asset is checked against:
 * - the `budget` of its settings (`vramMB`, `downloadMB`; defaults, rules, profile, asset JSON,
 *   later wins), for the whole asset: its `__vramBytes.out` and `__bytes.out`;
 * - a ceiling per encoded texture (§11 question 3): its slot's `maxSize`² at the codec's rate plus
 *   mips, from the settings without the asset JSON's own overrides. So a texture whose JSON raises
 *   its size or codec past its profile is caught. A `budget` in the asset JSON replaces it.
 *
 * Pass-throughs aren't checked: their images aren't read (no VRAM figure), and opting out of
 * optimization opts out of its budgets too. A production build fails for an asset over budget
 * that a shipped scene uses; `yarn assets` exits 1 for any; the dev server only warns.
 */

const MB = 1e6;

export const BUDGET_FIX =
  'Lower its maxSize or codec, pick a profile that allows it, or set its own "optimize": { "budget": { … } } in its JSON.';

const formatLimit = (limit: BudgetLimit) => `the ${limit.mb} MB budget of ${limit.from}`;

/** Why the result is over its budget, one line per limit; empty when it isn't (or isn't checked) */
export const getBudgetViolations = (result: PipelineRunResult): string[] => {
  if (result.status !== 'optimized') return [];
  const { budget } = result.settings;
  const figures = getResultFigures(result);
  const violations: string[] = [];
  const { vramMB, downloadMB } = budget;
  if (vramMB && figures?.vramBytes && figures.vramBytes.out > vramMB.mb * MB) {
    violations.push(`VRAM ${formatBytes(figures.vramBytes.out)} is over ${formatLimit(vramMB)}`);
  }
  if (downloadMB && figures && figures.bytes.out > downloadMB.mb * MB) {
    violations.push(
      `download ${formatBytes(figures.bytes.out)} is over ${formatLimit(downloadMB)}`
    );
  }
  if (budget.isOwn) return violations;

  const profile = result.settings.profile ? `the profile "${result.settings.profile}"` : null;
  for (const texture of result.textures) {
    const allowed = budget.profileTextures[texture.slot];
    if (allowed.maxSize === null) continue;
    const mipmaps = allowed.codec !== 'none' && allowed.mipmaps;
    const ceiling = estimateVramBytes(allowed.maxSize, allowed.maxSize, allowed.codec, mipmaps);
    const vram = estimateTextureVramBytes(texture).out;
    if (vram <= ceiling) continue;
    const label = texture.name ? `texture "${texture.name}"` : 'the texture';
    violations.push(
      `${label} (${texture.slot}, ${texture.width}×${texture.height} ${texture.codec}): VRAM ${formatBytes(vram)} is over the ${formatBytes(ceiling)} its slot's settings allow without the asset JSON's overrides (maxSize ${allowed.maxSize}, ${allowed.codec}${profile ? `, ${profile}` : ''})`
    );
  }
  return violations;
};
