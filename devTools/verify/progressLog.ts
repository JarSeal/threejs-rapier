/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { ROOT } from '../assetPipeline/sources';

/**
 * The verify commands' shared progress log (p601): every line they print also goes to
 * `.cache/verify/progress.log`, emptied when a run starts, so one command watches whichever run
 * is going, from any terminal: {@link PROGRESS_LOG_WATCH}.
 */
export const PROGRESS_LOG = path.join(ROOT, '.cache/verify/progress.log');

/** The command that follows the progress log */
export const PROGRESS_LOG_WATCH = `tail -f ${path.relative(ROOT, PROGRESS_LOG)}`;

let isStarted = false;

/** Prints a line and appends it to the progress log (a convenience: a failed write is ignored) */
export const out = (line = '', isError = false) => {
  if (isError) console.error(line);
  else console.log(line);
  try {
    if (!isStarted) {
      fs.mkdirSync(path.dirname(PROGRESS_LOG), { recursive: true });
      fs.writeFileSync(PROGRESS_LOG, '');
      isStarted = true;
    }
    fs.appendFileSync(PROGRESS_LOG, `${line}\n`);
  } catch {
    // Watching is optional
  }
};
