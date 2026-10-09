import { escapeHtml } from './html';
import { registerHubDirective, type HubMarkdownEnv } from './markdown';
import { getPageImageSources } from './scenes';
import { pageHref } from './shell';
import type { HubPage } from './types';

/**
 * `::: cards <page path>` … `:::` (p554 Phase 5, p555 §2.2): a card per child page of the page at
 * `<page path>` (`examples`), in menu order (`aek:order`, then label), each a link with the
 * child's `aek:image` (else its `aek:icon`), menu label and `aek:description`. Every page's image
 * is resolved before any page renders (`build.ts`), so a card can show it. The directive takes no
 * content. Out of the search: each card's page has its own results.
 *
 * p555 adds sources and filters (`features featured`).
 */

/** A card in a two-column grid of the content column (46rem): 23rem at 1x and 2x */
const CARD_IMAGE_WIDTHS = [400, 800];
const CARD_IMAGE_SIZES = '(min-width: 46rem) 23rem, 100vw';

const CARD_SOURCE_REGEX = /^[\w-]+(\/[\w-]+)*$/;

const renderCardMedia = (page: HubPage, env: HubMarkdownEnv, line: number) => {
  const image = getPageImageSources(page, env, CARD_IMAGE_WIDTHS, line);
  if (image) {
    const size = image.width ? ` width="${image.width}" height="${image.height}"` : '';
    return `<img class="hubCardImage" src="${image.src}" srcset="${image.srcset}" sizes="${CARD_IMAGE_SIZES}"${size} alt="" loading="lazy" decoding="async" />`;
  }
  if (page.icon) {
    return `<span class="hubCardIcon">${env.icons.render(page.icon, env.file, line)}</span>`;
  }
  return '';
};

const renderCard = (page: HubPage, env: HubMarkdownEnv, line: number) =>
  `<li class="hubCard"><a class="hubCardLink" href="${pageHref(env.root, page)}">${renderCardMedia(page, env, line)}<span class="hubCardBody"><span class="hubCardTitle">${escapeHtml(page.menu)}</span>${page.description ? `<span class="hubCardText">${escapeHtml(page.description)}</span>` : ''}</span></a></li>`;

registerHubDirective('cards', {
  open: (args, { env, line, tokens, idx }) => {
    if (tokens[idx + 1]?.type !== 'hub_directive_close') {
      env.diag.warn(env.file, line, '::: cards takes no content: it renders after the cards');
    }
    const source = args.trim();
    if (!CARD_SOURCE_REGEX.test(source)) {
      env.diag.error(
        env.file,
        line,
        `::: cards needs a page path whose child pages it shows ("::: cards examples"), not "${source}"`
      );
      return '';
    }
    const parent = env.tree?.byPath.get(`${source}/`);
    if (!parent) {
      if (env.tree) env.diag.error(env.file, line, `::: cards: no page at hub/pages/${source}/`);
      return '';
    }
    const children = parent.children.filter((child) => child.isInMenu);
    if (!children.length) {
      env.diag.warn(env.file, line, `::: cards: hub/pages/${source}/ has no child pages`);
      return '';
    }
    return `<ul class="hubCards hubSearchSkip">\n${children.map((child) => renderCard(child, env, line)).join('\n')}\n</ul>\n`;
  },
  close: () => '',
});
