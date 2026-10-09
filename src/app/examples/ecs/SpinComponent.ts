// #region spin-component (shown in the Hub: hub/pages/examples/ecs/)
// The SPIN component: its key and its data's type. No imports, so src/AppECSRegistry.ts can take
// it in without pulling any code along.

export const SpinComponentType = {
  SPIN: 'APP_SPIN',
} as const;

export type SpinData = {
  /** The axis to turn about, in the entity's own space (normalized by the system) */
  axis: { x: number; y: number; z: number };
  /** Radians per second */
  speed: number;
};

export interface SpinComponentData {
  [SpinComponentType.SPIN]: SpinData;
}
// #endregion spin-component
