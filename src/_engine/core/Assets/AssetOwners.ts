// Which scene owns each registered asset (geometry, texture, material, import record): the scene
// that was loading, or current, when the asset was registered, or the last one that got it from
// the cache. Assets registered before the first scene load have no owner.
//
// Keyed by the registered object itself, not its id or userData: setTextureOpts replaces a
// texture's userData, a clone copies it, and a deleted asset's entry goes with its object.
// This module has no imports: SceneLoader pushes the owner scene in with setAssetOwnerScene().

const owners = new WeakMap<object, string>();
let ownerSceneId: string | null = null;

/** Sets the scene that new registrations (and cache hits) belong to. SceneLoader calls this when
 * a load starts, with the scene being loaded, which then stays the owner while it is current. */
export const setAssetOwnerScene = (sceneId: string | null) => {
  ownerSceneId = sceneId;
};

/** Records the owner of a newly registered asset (none before the first scene load). */
export const recordAssetOwner = (asset: object) => {
  if (ownerSceneId) owners.set(asset, ownerSceneId);
};

/** Re-tags an asset returned from the cache to the scene getting it. An asset without an owner
 * (registered before the first scene load) is never claimed by a scene. */
export const retagAssetOwner = (asset: object) => {
  if (ownerSceneId && owners.has(asset)) owners.set(asset, ownerSceneId);
};

/** The id of the scene that owns the asset, or undefined if it has no owner. */
export const getAssetOwner = (asset: object) => owners.get(asset);
