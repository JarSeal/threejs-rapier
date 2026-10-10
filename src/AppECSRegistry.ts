// The app's own component keys, added to the engine's component map. Each app or toolkit module
// that owns a component adds its key in its own file the same way (eg. SpinComponent.ts): keep
// this file to the app-wide ones, with keys and types only.

export const AppComponentType = {
  HEALTH: 'APP_HEALTH',
} as const;

declare module 'aekasha' {
  interface ComponentDataMap {
    [AppComponentType.HEALTH]: { current: number; max: number };
  }
}
