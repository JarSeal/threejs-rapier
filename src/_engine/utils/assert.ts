import { lerror, lwarn } from './Logger';

/**
 * Checks whether an item exists and if it doesn't, throws an error
 * @param item (any) item to check with !item
 * @param msg (string) error message
 * @returns item
 */
export const existsOrThrow = <T>(item: T, msg: string) => {
  if (!item) {
    lerror(msg, `Item: '${item}'`);
    throw new Error(msg);
  }
  return item;
};

/**
 * Checks whether an item is undefined and if it doesn't, throws an error
 * @param item (any) item to check with !item
 * @param msg (string) error message
 * @param checkSpecific ('undefined' | 'null') optional parameter to check only undefined or null, if not defined will check both
 * @returns item
 */
export const isNotUndefinedNorNullOrThrow = <T>(
  item: T,
  msg: string,
  checkSpecific?: 'undefined' | 'null'
) => {
  if (checkSpecific) {
    if (
      (checkSpecific === 'undefined' && item === undefined) ||
      (checkSpecific === 'null' && item === null)
    ) {
      lerror(msg, `Item: '${item}'`);
      throw new Error(msg);
    }
    return item;
  }

  if (item === undefined || item === null) {
    lerror(msg, `Item: '${item}'`);
    throw new Error(msg);
  }
  return item;
};

/**
 * Checks whether an item exists and if it doesn't, logs a warning
 * @param item (any) item to check with !item
 * @param msg (string) error message
 * @returns item
 */
export const existsOrWarn = <T>(item: T, msg: string) => {
  if (!item) lwarn(msg, `Item: '${item}'`);
  return item;
};

/**
 * Checks whether an item is undefined and if it doesn't, logs a warning
 * @param item (any) item to check with !item
 * @param msg (string) error message
 * @param checkSpecific ('undefined' | 'null') optional parameter to check only undefined or null, if not defined will check both
 * @returns item
 */
export const isNotUndefinedNorNullOrWarn = <T>(
  item: T,
  msg: string,
  checkSpecific?: 'undefined' | 'null'
) => {
  if (checkSpecific) {
    if (
      (checkSpecific === 'undefined' && item === undefined) ||
      (checkSpecific === 'null' && item === null)
    ) {
      lwarn(msg, `Item: '${item}'`);
    }
    return item;
  }

  if (item === undefined || item === null) {
    lwarn(msg, `Item: '${item}'`);
  }
  return item;
};
