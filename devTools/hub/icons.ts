import fs from 'node:fs';
import path from 'node:path';
import type { HubDiagnostics } from './diagnostics';
import { parseAttributes } from './html';
import { HUB_ICONS_DIR } from './paths';

/**
 * The Hub's icons (p551 Phase 3): `hub/_assets/icons/<name>.svg`, inlined into the HTML at build
 * time so they take the text colour (`currentColor`) and cost no request. Lucide's (ISC,
 * `LICENSE-lucide.txt`) plus the Æ mark (`aekasha.svg`).
 */

/** The `<svg>` attributes an inlined icon keeps; size and class come from the Hub's CSS */
const KEPT_ATTRIBUTES = [
  'viewbox',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
];

/** The case SVG needs in HTML (attribute names are read lower-cased) */
const ATTRIBUTE_NAMES: Record<string, string> = { viewbox: 'viewBox' };

const toInlineSvg = (name: string, svg: string) => {
  const match = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i.exec(svg);
  if (!match) return null;
  const attributes = parseAttributes(match[1]);
  const kept = KEPT_ATTRIBUTES.filter((key) => key in attributes).map(
    (key) => `${ATTRIBUTE_NAMES[key] ?? key}="${attributes[key]}"`
  );
  const inner = match[2]
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
  return `<svg class="hubIcon hubIcon_${name}" ${kept.join(' ')} aria-hidden="true" focusable="false">${inner}</svg>`;
};

export type HubIcons = {
  /** The icon's inline `<svg>`, or '' with an error at `file`:`line` when there's none */
  render: (name: string, file: string, line?: number) => string;
};

/** Reads the icons once per build */
export const loadHubIcons = (diag: HubDiagnostics): HubIcons => {
  const icons = new Map<string, string>();
  const names = fs.existsSync(HUB_ICONS_DIR) ? fs.readdirSync(HUB_ICONS_DIR) : [];
  for (const fileName of names.filter((n) => n.endsWith('.svg'))) {
    const name = fileName.slice(0, -'.svg'.length);
    const file = path.join(HUB_ICONS_DIR, fileName);
    const svg = toInlineSvg(name, fs.readFileSync(file, 'utf-8'));
    if (svg) icons.set(name, svg);
    else diag.error(file, 1, 'Not an SVG: no <svg>…</svg>');
  }
  return {
    render: (name, file, line) => {
      const svg = icons.get(name);
      if (svg) return svg;
      diag.error(
        file,
        line,
        `Unknown icon "${name}": no hub/_assets/icons/${name}.svg (Lucide's are at lucide.dev)`
      );
      return '';
    },
  };
};
