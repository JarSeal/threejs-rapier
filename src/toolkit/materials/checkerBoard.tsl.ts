import { type Node } from 'three/tsl';

export const colorNode = (inputs: { baseColor: Node; panelColor: Node; gridScale: Node }) => {
  // @TODO: Create checkerboard material
  const baseColor = inputs.baseColor;
  const panelColor = inputs.panelColor;
  const gridScale = inputs.gridScale;
  return baseColor.mul!(gridScale).add!(panelColor);
};

export const roughnessNode = (inputs: { baseRoughness: Node; scratchIntensity: Node }) => {
  const roughness = inputs.baseRoughness;
  const scratchIntensity = inputs.scratchIntensity;
  return roughness.add!(scratchIntensity);
};

export const normalNode = (inputs: { bumpScale: Node }) => {
  const bumpScale = inputs.bumpScale;
  return bumpScale;
};
