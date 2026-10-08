import { toRepoPath } from './paths';

export type HubDiagnostic = {
  level: 'error' | 'warning';
  /** Absolute */
  file: string;
  /** 1-based, when known */
  line?: number;
  message: string;
};

/** The errors and warnings of one Hub build, each with its file and line */
export class HubDiagnostics {
  readonly items: HubDiagnostic[] = [];

  error(file: string, line: number | undefined, message: string) {
    this.items.push({ level: 'error', file, line, message });
  }

  warn(file: string, line: number | undefined, message: string) {
    this.items.push({ level: 'warning', file, line, message });
  }

  get errors() {
    return this.items.filter((item) => item.level === 'error');
  }

  get warnings() {
    return this.items.filter((item) => item.level === 'warning');
  }

  /** The errors in one file (a page's, for its error page) */
  errorsIn(files: string[]) {
    return this.errors.filter((item) => files.includes(item.file));
  }
}

/** `hub/pages/examples/setup.md:12: message`, the form editors and terminals link */
export const formatDiagnostic = ({ file, line, message }: HubDiagnostic) =>
  `${toRepoPath(file)}${line ? `:${line}` : ''}: ${message}`;

/** The 1-based line of an offset in a text */
export const lineAt = (text: string, offset: number) => {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
};
