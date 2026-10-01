/** What moves a character (eg. createDynamicCharacter's controller). */
export type CharacterController = {
  /** Runs once per fixed physics sub-step (APP_PHYSICS_STEP), with the fixed timestep. */
  tick: (dt: number) => void;
  /** Runs when the character's entity is deleted, before its components are gone. */
  dispose?: () => void;
};

/** A character's registry entry: the data of its entity's `CHARACTER` component. */
export type CharacterObject = {
  id: string;
  name?: string;
  entityId: number;
  /** App id of the visual root (the Object3D the body moves). */
  visualId: string;
  /** Binding ids owned by this character (namespaced `${id}:…`), deleted with it. */
  keyBindingIds: string[];
  mouseBindingIds: string[];
  /** Live controller data. Keys follow the naming convention the debug tools rely on: no prefix =
   * state, `_` = configuration, `__` = internal memory. */
  data: Record<string, unknown>;
  /** Set by the controller's creator once the character exists (until then nothing ticks). */
  controller?: CharacterController;
};
