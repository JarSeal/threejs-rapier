import { time, uv, type Node } from 'three/tsl';

export const colorNode = (inputs: {
  baseColor: Node;
  panelColor: Node;
  gridScale: Node;
  texture: Node;
}) => {
  const baseColor = inputs.baseColor;
  const panelColor = inputs.panelColor;
  const gridScale = inputs.gridScale;

  const texColor = inputs.texture;

  const timeOffset = time.mul(0.5).fract();

  // Apply the bounded offset to your scaled coordinates
  const customUVs = uv().mul(2.0).add(timeOffset);

  // Sample safely
  const customSampledColor = texColor.sample(customUVs);

  return baseColor.mul!(gridScale).add!(panelColor).mul(customSampledColor.rgb);
};
