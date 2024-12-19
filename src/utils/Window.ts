// @TODO: add JSDoc comment
export const getWindowSize = () => {
  const width = window.innerWidth;
  const height = window.innerHeight;

  return {
    width,
    height,
    aspect: width / height,
  };
};
