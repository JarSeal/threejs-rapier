/**
 * The clock for measurement only (step timing, messaging latency, gate hold times, ray stats and
 * debug display lifetimes): never an input to the simulation, which counts time in steps
 * (`getPhysicsSubStepIndex`). The simulation lint (`SIMULATION_FILES` in `eslint.config.js`)
 * forbids `performance.now()` in simulation code and allows this one instead, so every wall-clock
 * read there says what it's for. Milliseconds since the thread's time origin, like
 * `performance.now()`: a worker's reading needs the main thread's offset to compare.
 *
 * @internal
 */
export const readStatsClock = () => performance.now();
