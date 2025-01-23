export const getFileNameExt = (fileName?: unknown) => {
  if (typeof fileName !== 'string') return null;
  const splitFileName = (fileName || '').split('.');
  return splitFileName[splitFileName.length - 1];
};

export const isHDR = (fileName?: unknown) => getFileNameExt(fileName) === 'hdr';
export const isJPG = (fileName?: unknown) => getFileNameExt(fileName) === 'jpg';
export const isPNG = (fileName?: unknown) => getFileNameExt(fileName) === 'png';
