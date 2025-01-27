/**
 * Returns the window inner width and height, and their aspect ratio
 * @returns ({ width: number, height: number, aspect: number })
 */
export const getWindowSize = () => {
  const width = window.innerWidth;
  const height = window.innerHeight;

  return {
    width,
    height,
    aspect: width / height,
  };
};
