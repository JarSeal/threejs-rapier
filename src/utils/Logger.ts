/* eslint-disable @typescript-eslint/no-unused-vars */

let loggerInitiated = false;
let logger:
  | {
      log: (...data: unknown[]) => void;
      warn: (...data: unknown[]) => void;
      error: (...data: unknown[]) => void;
    }
  | Console = {
  log: (..._data: unknown[]) => undefined,
  warn: (..._data: unknown[]) => undefined,
  error: (..._data: unknown[]) => undefined,
};

const initLogger = () => {
  if (loggerInitiated) return;
  // @TODO: Do not init the logger for production, but enable it when a certain
  // url param is set (?useLogger=1)
  logger = console;
  loggerInitiated = true;
};

// @TODO: add JSDoc comment
export const getLogger = () => {
  initLogger();
  return logger;
};

// @TODO: add JSDoc comment
export const llog = (...data: unknown[]) => {
  initLogger();
  return logger.log(...data);
};

// @TODO: add JSDoc comment
export const lwarn = (...data: unknown[]) => {
  initLogger();
  return logger.warn(...data);
};

// @TODO: add JSDoc comment
export const lerror = (...data: unknown[]) => {
  initLogger();
  return logger.error(...data);
};
