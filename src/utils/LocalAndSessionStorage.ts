export type StorageValue = boolean | number | string;

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
  return lsValue; // typeof string
};

// Local Storage
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

export const lsSetItem = (key: string, value: StorageValue) => {
  checkStorage('local');
  if (!lsAvailable) return;
  localStorage.setItem(key, String(value));
};

export const lsRemoveItem = (key: string) => {
  checkStorage('local');
  if (!lsAvailable) return;
  localStorage.removeItem(key);
};

// Session Storage
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

export const ssSetItem = (key: string, value: StorageValue) => {
  checkStorage('session');
  if (!ssAvailable) return;
  sessionStorage.setItem(key, String(value));
};

export const ssRemoveItem = (key: string) => {
  checkStorage('session');
  if (!ssAvailable) return;
  sessionStorage.removeItem(key);
};
