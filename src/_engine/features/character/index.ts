export {
  createCharacter,
  deleteCharacter,
  getCharacterById,
  getCharacters,
  onLocomotionStateChange,
  registerOnDeleteCharacter,
  setControlMode,
} from '../../core/Character';
export type { CreateCharacterOpts } from '../../core/Character';
export type {
  CharacterControlMode,
  CharacterObject,
  LocomotionStateListener,
} from '../../core/Character/CharacterTypes';
export { createDynamicCharacter } from '../../core/Character/DynamicCharacter';
export type { DynamicCharacter, DynamicCharacterOpts } from '../../core/Character/DynamicCharacter';
