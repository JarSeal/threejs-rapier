import { lerror } from '../utils/Logger';
import { getFatLineBackendFactory, loadFatLineBackend } from './Lines/LineBackend';
import { LineObject } from './Lines/LineObject';
import {
  getRegisteredLine,
  getRegisteredLines,
  nextLineId,
  registerLine,
} from './Lines/LineRegistry';
import type { LineProps } from './Lines/LineTypes';

export { LineObject } from './Lines/LineObject';
export type { LineWriter } from './Lines/LineWriter';
export type * from './Lines/LineTypes';
export * from './Lines/LineBuilders';

/**
 * Creates a line-segment object and attaches it (to the root scene unless `props.attach`
 * says otherwise). The returned handle is plain gameplay API: no ECS world involved. It
 * lives until it is disposed or the scene changes — every line is disposed on a scene
 * switch (disposeAllLines), so create scene lines from the scene, not once at startup.
 *
 * A line wider than 1px needs the thick-line backend, which is loaded on demand: until it
 * arrives the line draws 1px and then upgrades itself. Await `preloadFatLineBackend()`
 * first when the width must be right on the first frame.
 *
 * @example
 * // Build once
 * const outline = createLines({ segments: box3EdgesToSegments(box), color: 0x00ffff });
 *
 * // Refill every frame, allocation-free
 * const trail = createLines({ capacity: 256, growth: 'FIXED' });
 * const w = trail.beginWrite();
 * for (...) w.segment(ax, ay, az, bx, by, bz);
 * trail.endWrite();
 */
export const createLines = (props: LineProps = {}): LineObject => {
  const id = props.id ?? nextLineId();
  if (getRegisteredLine(id)) {
    const msg = `A line with the id "${id}" already exists. Dispose the old line first or pick another id (createLines).`;
    lerror(msg);
    throw new Error(msg);
  }
  const line = new LineObject(id, props);
  registerLine(line);
  return line;
};

/** Returns a live line by id. */
export const getLine = (id: string) => getRegisteredLine(id);

/** Returns every live line. */
export const getAllLines = () => Array.from(getRegisteredLines().values());

/** Disposes every live line. Runs on every scene switch (SceneLoader). */
export const disposeAllLines = () => {
  for (const line of getAllLines()) line.dispose();
};

/**
 * Loads the thick-line (FAT) backend, which draws lines wider than 1px. It lives in its own
 * chunk so an app that only draws 1px lines never downloads it — which also means a width
 * above 1px can never be honoured synchronously. Lines created before it has loaded draw
 * 1px and upgrade themselves when it arrives; await this first to avoid that.
 * @returns (Promise<boolean>) whether the backend is available
 */
export const preloadFatLineBackend = () => loadFatLineBackend();

/** Whether the thick-line backend has loaded (new wide lines are then created thick). */
export const isFatLineBackendAvailable = () => getFatLineBackendFactory() !== null;
