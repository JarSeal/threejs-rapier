import * as THREE from 'three/webgpu';
import { getRenderer } from '../Renderer';

/** Baked PMREMs by source texture, disposed with the source texture. */
const pmrems = new WeakMap<THREE.Texture, { target: THREE.RenderTarget; version: number }>();

/** Same checks as PMREMNode's (isEquirectangularMapReady / isCubeMapReady). */
export const isPMREMSourceReady = (texture: THREE.Texture) => {
  const image = texture.image as { height?: number; [index: number]: unknown } | null | undefined;
  if (!image) return false;
  if ((texture as THREE.CubeTexture).isCubeTexture) {
    for (let i = 0; i < 6; i++) if (image[i] === undefined) return false;
    return true;
  }
  return (image.height || 0) > 0;
};

/**
 * The texture to give pmremTexture(): a PMREM baked here (once per source texture and PMREM
 * version), disposed when its source texture is disposed. A PMREMNode given the source texture
 * itself bakes it with a PMREMGenerator of its own, and nothing ever disposes either. A source
 * that isn't ready (eg. a failed load) is returned as is, for PMREMNode to bake once it is.
 */
export const getPMREMTexture = (texture: THREE.Texture) => {
  const renderer = getRenderer();
  if (!renderer || !isPMREMSourceReady(texture)) return texture;
  const cached = pmrems.get(texture);
  if (cached?.version === texture.pmremVersion) return cached.target.texture;

  // A generator per bake, disposed right after: its working set (a ping-pong target as large as
  // the PMREM, LOD planes, blur materials) would otherwise stay on the GPU. Before the renderer
  // has initialized, the generator bakes asynchronously, so it can't be disposed here.
  const generator = new THREE.PMREMGenerator(renderer);
  const target = (texture as THREE.CubeTexture).isCubeTexture
    ? generator.fromCubemap(texture, cached?.target)
    : generator.fromEquirectangular(texture, cached?.target);
  if (renderer.hasInitialized()) generator.dispose();
  if (!cached) {
    const onDispose = () => {
      texture.removeEventListener('dispose', onDispose);
      pmrems.get(texture)?.target.dispose();
      pmrems.delete(texture);
    };
    texture.addEventListener('dispose', onDispose);
  }
  pmrems.set(texture, { target, version: texture.pmremVersion });
  return target.texture;
};
