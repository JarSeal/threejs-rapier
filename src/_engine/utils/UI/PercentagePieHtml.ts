import { CMP, type TCMP } from '../CMP';

export type PercentagePieOpts = {
  /** Width and height of the pie (CSS length), default 1rem (from the .percentagePie style) */
  height?: string;
  /** Extra class for the pie element */
  mainClass?: string;
  /** Extra class for the pie element (the pie is one element, so this is the same as mainClass) */
  fillClass?: string;
  /** Fill color (CSS color), default #fff (from the .percentagePie style) */
  fillColor?: string;
};

/** A live pie from {@link createPercentagePie}. */
export type PercentagePie = {
  cmp: TCMP;
  /**
   * Sets the filled percentage (clamped to 0..100 and rounded). Writes only the `--p` custom
   * property, and only when the rounded value changed.
   */
  set: (percentage: number) => void;
};

const clampPercentage = (percentage: number) =>
  Math.round(Math.min(100, Math.max(0, percentage || 0)));

const getPieClasses = (opts?: PercentagePieOpts) => {
  const classes = ['percentagePie'];
  if (opts?.mainClass) classes.push(opts.mainClass);
  if (opts?.fillClass) classes.push(opts.fillClass);
  return classes;
};

/**
 * Percentage pie as an HTML string (one span, styled by `.percentagePie` in debugger.scss), for
 * one-off markup. Use {@link createPercentagePie} for a pie that updates.
 * @param percentage (number) filled percentage, 0..100
 * @param opts ({@link PercentagePieOpts}) optional pie options
 * @returns (string) the pie html
 */
export const PercentagePieHtml = (percentage: number = 0, opts?: PercentagePieOpts) => {
  let style = `--p: ${clampPercentage(percentage)};`;
  if (opts?.height) style += ` width: ${opts.height}; height: ${opts.height};`;
  if (opts?.fillColor) style += ` --pie-fill: ${opts.fillColor};`;
  return `<span class="${getPieClasses(opts).join(' ')}" style="${style}"></span>`;
};

/**
 * Creates a percentage pie CMP (one span, styled by `.percentagePie` in debugger.scss) that is
 * updated with `set`, without touching its html.
 * @param opts ({@link PercentagePieOpts}) optional pie options
 * @returns ({@link PercentagePie}) the pie CMP and its setter
 */
export const createPercentagePie = (opts?: PercentagePieOpts): PercentagePie => {
  const cmp = CMP({
    tag: 'span',
    class: getPieClasses(opts),
    ...(opts?.height ? { style: { width: opts.height, height: opts.height } } : {}),
  });
  const style = cmp.elem.style;
  if (opts?.fillColor) style.setProperty('--pie-fill', opts.fillColor);
  let current = 0;
  style.setProperty('--p', '0');
  return {
    cmp,
    set: (percentage) => {
      const next = clampPercentage(percentage);
      if (next === current) return;
      current = next;
      style.setProperty('--p', String(next));
    },
  };
};
