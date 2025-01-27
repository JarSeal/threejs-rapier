/**
 * Returns the file name extension from a string
 * @param fileName (string) optional file name, if not provided then this will return null
 * @returns (string | null)
 */
export const getFileNameExt = (fileName?: unknown) => {
  if (typeof fileName !== 'string') return null;
  const splitFileName = (fileName || '').split('.');
  return splitFileName[splitFileName.length - 1];
};

/**
 * Determines whether the file name provided has an 'hdr' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isHDR = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'hdr';

/**
 * Determines whether the file name provided has an 'jpg' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isJPG = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'jpg';

/**
 * Determines whether the file name provided has an 'png' extension
 * @param fileName (string) optional file name
 * @returns (boolean)
 */
export const isPNG = (fileName?: unknown) =>
  String(getFileNameExt(fileName)).toLowerCase() === 'png';
