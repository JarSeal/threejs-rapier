// Local Storage
// class LocalStorage {
//   constructor(keyPrefix) {
//     this.keyPrefix = keyPrefix || '';
//     this.localStorageAvailable = this._lsTest();
//   }

//   getItem(key, defaultValue) {
//     // defaultValue is returned (if provided) if local storage is not available or the key is not found
//     if (!this.localStorageAvailable) return defaultValue || null;
//     if (this.checkIfItemExists(key)) {
//       return localStorage.getItem(this.keyPrefix + key);
//     } else {
//       return defaultValue || null;
//     }
//   }

//   checkIfItemExists(key) {
//     if (!this.localStorageAvailable) return false;
//     return Object.prototype.hasOwnProperty.call(localStorage, this.keyPrefix + key);
//   }

//   setItem(key, value) {
//     if (!this.localStorageAvailable) return false;
//     localStorage.setItem(this.keyPrefix + key, value);
//     return true;
//   }

//   removeItem(key) {
//     if (!this.localStorageAvailable) return false;
//     if (this.checkIfItemExists(key)) {
//       localStorage.removeItem(this.keyPrefix + key);
//     }
//     return true;
//   }

//   convertValue(defaultValue, lsValue) {
//     if (typeof defaultValue === 'boolean') {
//       return lsValue === 'true';
//     } else if (typeof defaultValue === 'number') {
//       return Number(lsValue);
//     } else {
//       // typeof string
//       return lsValue;
//     }
//   }

//   _lsTest() {
//     const test = this.keyPrefix + 'testLSAvailability';
//     try {
//       localStorage.setItem(test, test);
//       localStorage.removeItem(test);
//       return true;
//     } catch (e) {
//       return false;
//     }
//   }
// }

// // Session Storage
// class SessionStorage {
//   constructor(keyPrefix) {
//     this.keyPrefix = keyPrefix || '';
//     this.sessionStorageAvailable = this._lsTest();
//   }

//   getItem(key, defaultValue) {
//     // defaultValue is returned (if provided) if session storage is not available or the key is not found
//     if (!this.sessionStorageAvailable) return defaultValue || null;
//     if (this.checkIfItemExists(key)) {
//       return sessionStorage.getItem(this.keyPrefix + key);
//     } else {
//       return defaultValue || null;
//     }
//   }

//   checkIfItemExists(key) {
//     if (!this.sessionStorageAvailable) return false;
//     return Object.prototype.hasOwnProperty.call(sessionStorage, this.keyPrefix + key);
//   }

//   setItem(key, value) {
//     if (!this.sessionStorageAvailable) return false;
//     sessionStorage.setItem(this.keyPrefix + key, value);
//     return true;
//   }

//   removeItem(key) {
//     if (!this.sessionStorageAvailable) return false;
//     if (this.checkIfItemExists(key)) {
//       sessionStorage.removeItem(this.keyPrefix + key);
//     }
//     return true;
//   }

//   convertValue(defaultValue, lsValue) {
//     if (typeof defaultValue === 'boolean') {
//       return lsValue === 'true';
//     } else if (typeof defaultValue === 'number') {
//       return Number(lsValue);
//     } else {
//       // typeof string
//       return lsValue;
//     }
//   }

//   _lsTest() {
//     const test = this.keyPrefix + 'testSSAvailability';
//     try {
//       sessionStorage.setItem(test, test);
//       sessionStorage.removeItem(test);
//       return true;
//     } catch (e) {
//       return false;
//     }
//   }
// }
