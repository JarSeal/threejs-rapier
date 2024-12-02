let loggerInitiated = false;
let logger:
  | {
      log: (...data: any[]) => void;
      warn: (...data: any[]) => void;
      error: (...data: any[]) => void;
    }
  | Console = {
  log: (..._data: any[]) => undefined,
  warn: (..._data: any[]) => undefined,
  error: (..._data: any[]) => undefined,
};

const initLogger = () => {
  if (loggerInitiated) return;
  // @TODO: Do not init the logger for production
  logger = console;
  loggerInitiated = true;
};

export const getLogger = () => {
  initLogger();
  return logger;
};

export const llog = (...data: any[]) => {
  initLogger();
  return logger.log(...data);
};
export const lwarn = (...data: any[]) => {
  initLogger();
  return logger.warn(...data);
};
export const lerror = (...data: any[]) => {
  initLogger();
  return logger.error(...data);
};
