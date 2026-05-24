import { color, uniform } from 'three/tsl';

export const material = (inputs: { color: string; roughness: number }) => {
  const baseColor = uniform(color(inputs.color));
  const roughnessNode = uniform(inputs.roughness);

  return baseColor.mul(roughnessNode);
};
