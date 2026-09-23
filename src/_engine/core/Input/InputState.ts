// Master input switch shared by every input domain (Keyboard/Mouse/Touch). Lives in its own
// tiny file so engine code that only needs to pause input (e.g. SceneLoader.ts during a scene
// load) doesn't pull any domain module into the bundle. Each domain's own
// set*InputsEnabled switch still applies on top of this one.

let allInputsEnabled = true;

/** Enables/disables every input binding (keyboard, mouse, touch) at once. */
export const setAllInputsEnabled = (enabled: boolean): void => {
  allInputsEnabled = enabled;
};

export const areAllInputsEnabled = (): boolean => allInputsEnabled;
