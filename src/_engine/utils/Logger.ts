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

// @TODO: add setLogger that sets a custom logger to replace the default

/**
 * Returns the logger
 * @returns ({@link logger})
 */
export const getLogger = () => {
  initLogger();
  return logger;
};

/**
 * Logs data as info type
 * @param data (...unknow[])
 */
export const llog = (...data: unknown[]) => {
  initLogger();
  logger.log(...data);
};

/**
 * Logs data as warning type
 * @param data (...unknow[])
 */
export const lwarn = (...data: unknown[]) => {
  initLogger();
  logger.warn(...data);
};

/**
 * Logs data as error type
 * @param data (...unknow[])
 */
export const lerror = (...data: unknown[]) => {
  initLogger();
  logger.error(...data);
};
