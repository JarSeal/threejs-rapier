// #region spin-component (shown in the Hub: hub/pages/examples/ecs/)
// The SPIN component: its key and its data's type.

export const SpinComponentType = {
  SPIN: 'APP_SPIN',
} as const;

export type SpinData = {
  /** The axis to turn about, in the entity's own space (normalized by the system) */
  axis: { x: number; y: number; z: number };
  /** Radians per second */
  speed: number;
};
// #endregion spin-component

// #region spin-component-map (shown in the Hub: hub/pages/examples/ecs/)
// Adds SPIN to the engine's component map, so addComponent and getStorage know its data's type
declare module 'aekasha' {
  interface ComponentDataMap {
    [SpinComponentType.SPIN]: SpinData;
  }
}
// #endregion spin-component-map
