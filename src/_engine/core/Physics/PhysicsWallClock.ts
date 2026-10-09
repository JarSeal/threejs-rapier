/**
 * The wall clock under `getPhysGameTime()` and its pause bookkeeping, the one wall-clock read the
 * simulation still takes (the characters' tumble timing and wall-cast ages), so it isn't
 * deterministic. The simulation lint (`SIMULATION_FILES` in `eslint.config.js`) allow-lists this
 * file alone; p610 replaces `getPhysGameTime()` with step-index time and deletes it. Measurement
 * reads use `readStatsClock` (`utils/StatsClock.ts`) instead.
 *
 * @internal
 */
export const readPhysicsWallClock = () => performance.now();
