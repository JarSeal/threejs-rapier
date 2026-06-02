import { type Node } from 'three/tsl';

export const colorNode = (inputs: { baseColor: Node; panelColor: Node; gridScale: Node }) => {
  const baseColor = inputs.baseColor;
  const panelColor = inputs.panelColor;
  const gridScale = inputs.gridScale;

  return baseColor.mul!(gridScale).add!(panelColor);
};
