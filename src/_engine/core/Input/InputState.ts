// Master input switch shared by every input domain (Keyboard/Mouse/Touch). Lives in its own
// tiny file so engine code that only needs to pause input (e.g. SceneLoader.ts during a scene
// load) doesn't pull any domain module into the bundle. Each domain's own
// set*InputsEnabled switch still applies on top of this one.

let allInputsEnabled = true;
let appInputsSuspended = false;

/** Enables/disables every input binding (keyboard, mouse, touch) at once. */
export const setAllInputsEnabled = (enabled: boolean): void => {
  allInputsEnabled = enabled;
};

export const areAllInputsEnabled = (): boolean => allInputsEnabled;

/**
 * Suspends the app's input bindings (keyboard, mouse, touch) while an editor view is active
 * (ViewManager.ts). Debug key bindings (`isDebugKey`) keep running. Apart from
 * {@link setAllInputsEnabled}, so a scene load's re-enable at its end doesn't lift it.
 */
export const setAppInputsSuspended = (suspended: boolean): void => {
  appInputsSuspended = suspended;
};

export const areAppInputsSuspended = (): boolean => appInputsSuspended;

/** Whether the app's input bindings run: every input is enabled and no editor view suspends them. */
export const areAppInputsEnabled = (): boolean => allInputsEnabled && !appInputsSuspended;
