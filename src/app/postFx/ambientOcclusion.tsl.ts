import { vec4 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type { PostFxPassFn } from '../../_engine/core/PostFX/PostFXTypes';
import { lwarn } from '../../_engine/utils/Logger';

/** Ground Truth Ambient Occlusion (three's GTAONode), multiplied over the incoming color. */
export const fxNode: PostFxPassFn = (params, ctx) => {
  const aoPass = ao(ctx.sceneDepthNode, ctx.sceneNormalNode, ctx.camera);

  const setParam = (key: string, value: unknown) => {
    switch (key) {
      case 'radius':
      case 'thickness':
      case 'distanceExponent':
      case 'distanceFallOff':
      case 'scale':
      case 'samples':
        aoPass[key].value = value as number;
        break;
      case 'resolutionScale':
        aoPass.resolutionScale = value as number;
        // Applies on the next frame: GTAONode.updateBefore() calls setSize() every frame
        break;
      case 'useTemporalFiltering':
        aoPass.useTemporalFiltering = value as boolean;
        if (value) {
          lwarn(
            'PostFX pass "ambientOcclusion": useTemporalFiltering needs a TRAA PostFX pass in the chain after it, otherwise the AO noise flickers.'
          );
        }
        break;
    }
  };
  // Applied before the first frame, so resolutionScale is in place before the first setSize()
  for (const [key, value] of Object.entries(params)) setParam(key, value);

  // The AO render target is single channel (RedFormat), so only its .r is meaningful.
  // Only the color is occluded, alpha is kept.
  const aoValue = aoPass.getTextureNode().r;
  const node = vec4(ctx.colorNode.rgb.mul(aoValue), ctx.colorNode.a);

  return {
    node,
    profileNodes: [aoPass],
    setParam,
    onDispose: () => aoPass.dispose(),
  };
};
