import { toRepoPath } from './paths';

export type HubDiagnostic = {
  level: 'error' | 'warning';
  /** Absolute */
  file: string;
  /** 1-based, when known */
  line?: number;
  message: string;
};

/**
 * The errors and warnings of one Hub build, each with its file and line. The same one is kept
 * once: the shell's own errors come up for every page it's filled with.
 */
export class HubDiagnostics {
  readonly items: HubDiagnostic[] = [];
  private readonly keys = new Set<string>();

  private add(item: HubDiagnostic) {
    const key = diagnosticKey(item);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.items.push(item);
  }

  error(file: string, line: number | undefined, message: string) {
    this.add({ level: 'error', file, line, message });
  }

  warn(file: string, line: number | undefined, message: string) {
    this.add({ level: 'warning', file, line, message });
  }

  get errors() {
    return this.items.filter((item) => item.level === 'error');
  }

  get warnings() {
    return this.items.filter((item) => item.level === 'warning');
  }
}

/** Tells diagnostics apart: the same key is the same diagnostic (the dev plugin's "new" ones) */
export const diagnosticKey = ({ level, file, line, message }: HubDiagnostic) =>
  `${level}\0${file}\0${line ?? ''}\0${message}`;

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
