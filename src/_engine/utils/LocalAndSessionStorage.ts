export type StorageValue =
  | boolean
  | number
  | string
  | null
  | { [key: string]: unknown }
  | (boolean | number | string | null | { [key: string]: unknown })[];

let lsAvailable: null | boolean = null;
let ssAvailable: null | boolean = null;

const checkStorage = (type: 'local' | 'session' = 'local') => {
  if (type === 'local') {
    if (lsAvailable !== null) return;
    try {
      const test = '__testLocalStorageAvailability';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      lsAvailable = true;
    } catch (e) {
      lsAvailable = false;
    }
  } else {
    if (ssAvailable !== null) return;
    try {
      const test = '__testSessionStorageAvailability';
      sessionStorage.setItem(test, test);
      sessionStorage.removeItem(test);
      ssAvailable = true;
    } catch (e) {
      ssAvailable = false;
    }
  }
};

const checkIfItemExists = (key: string) => {
  if (!lsAvailable) return false;
  return Object.prototype.hasOwnProperty.call(localStorage, key);
};

const convertValue = (defaultValue: StorageValue, lsValue: string) => {
  if (typeof defaultValue === 'boolean') return lsValue === 'true';
  if (typeof defaultValue === 'number') return Number(lsValue);
  if (Array.isArray(defaultValue) || (typeof defaultValue === 'object' && defaultValue !== null))
    return JSON.parse(lsValue);
  return lsValue; // typeof string
};

/**
 * Returns a possible value from the LocalStorage based on the key provided
 * @param key (string) key of LocalStorage item
 * @param defaultValue ({@link StorageValue}) if no value is found with the key provided then the default value is returned
 * @param doNotConvert (boolean) optional value to determine whether the value should be converted to the same type as the default value or not
 * @returns (any)
 */
export const lsGetItem = (key: string, defaultValue: StorageValue, doNotConvert?: boolean) => {
  checkStorage('local');
  if (!lsAvailable) return defaultValue || null;
  if (checkIfItemExists(key)) {
    const rawValue = localStorage.getItem(key);
    if (doNotConvert || rawValue === null) return rawValue;
    return convertValue(defaultValue, rawValue);
  } else {
    return defaultValue || null;
  }
};

/**
 * Saves the value provided with the key to the LocalStorage
 * @param key (string) key of the value being stored
 * @param value ({@link StorageValue}) value to be stored
 */
export const lsSetItem = (key: string, value: StorageValue) => {
  checkStorage('local');
  if (!lsAvailable) return;
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    value = JSON.stringify(value);
  }
  localStorage.setItem(key, String(value));
};

/**
 * Removes the key value pair from the LocalStorage
 * @param key (string) key of the value to remove
 */
export const lsRemoveItem = (key: string) => {
  checkStorage('local');
  if (!lsAvailable) return;
  localStorage.removeItem(key);
};

/**
 * Returns a possible value from the SessionStorage based on the key provided
 * @param key (string) key of SessionStorage item
 * @param defaultValue ({@link StorageValue}) if no value is found with the key provided then the default value is returned
 * @param doNotConvert (boolean) optional value to determine whether the value should be converted to the same type as the default value or not
 * @returns (any)
 */
export const ssGetItem = (key: string, defaultValue: StorageValue, doNotConvert?: boolean) => {
  checkStorage('session');
  if (!ssAvailable) return defaultValue || null;
  if (checkIfItemExists(key)) {
    const rawValue = sessionStorage.getItem(key);
    if (doNotConvert || rawValue === null) return rawValue;
    return convertValue(defaultValue, rawValue);
  } else {
    return defaultValue || null;
  }
};

/**
 * Saves the value provided with the key to the SessionStorage
 * @param key (string) key of the value being stored
 * @param value ({@link StorageValue}) value to be stored
 */
export const ssSetItem = (key: string, value: StorageValue) => {
  checkStorage('session');
  if (!ssAvailable) return;
  sessionStorage.setItem(key, String(value));
};

/**
 * Removes the key value pair from the SessionStorage
 * @param key (string) key of the value to remove
 */
export const ssRemoveItem = (key: string) => {
  checkStorage('session');
  if (!ssAvailable) return;
  sessionStorage.removeItem(key);
};
