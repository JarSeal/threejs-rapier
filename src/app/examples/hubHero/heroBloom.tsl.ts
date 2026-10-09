import { vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { PostFxPassFn } from '../../../_engine/core/PostFX/PostFXTypes';

/** three's BloomNode, added over the incoming colour (alpha is kept) */
export const fxNode: PostFxPassFn = (params, ctx) => {
  const bloomPass = bloom(ctx.colorNode);

  const setParam = (key: string, value: unknown) => {
    if (key === 'strength' || key === 'radius' || key === 'threshold') {
      bloomPass[key].value = value as number;
    }
  };
  for (const [key, value] of Object.entries(params)) setParam(key, value);

  return {
    node: vec4(ctx.colorNode.rgb.add(bloomPass.rgb), ctx.colorNode.a),
    profileNodes: [bloomPass],
    setParam,
    onDispose: () => bloomPass.dispose(),
  };
};
