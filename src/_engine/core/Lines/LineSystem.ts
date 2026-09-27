import { ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld } from '../ECS';
import { getElapsedTime } from '../MainLoop';
import { lineTimeUniform } from './LinePulse';

let registered = false;

/** Writes the one time value every pulsing line reads. Lines never refill or animate
 * anything else here: consumers own their own refill cadence. */
const lineTimeSystem = () => {
  lineTimeUniform.value = getElapsedTime();
};

/**
 * @internal
 * Registers the line time system on every world (a core plugin, on `MAIN`, which runs
 * whenever the master loop plays — so pulses keep going while only the app loop is
 * paused). Idempotent.
 *
 * Lines belong to no world, yet this is the only per-frame hook: with several worlds it
 * runs once per world, which is harmless (the same monotonic value is written each time);
 * with none, pulses would stand still. InitApp always creates the default world.
 */
export const registerLineTimeSystem = () => {
  if (registered) return;
  registered = true;
  ECSWorld.registerCorePlugin((world) => {
    world.addSystem(ECSSystemStage.MAIN, 'lineTimeSystem', lineTimeSystem);
    return world;
  });
};
