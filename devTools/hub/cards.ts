import { escapeHtml } from './html';
import { registerHubDirective, type HubMarkdownEnv } from './markdown';
import { getPageImageSources } from './scenes';
import { pageHref } from './shell';
import type { HubPage } from './types';

/**
 * `::: cards <page path> [featured] [group=<name>]` … `:::` (p554 Phase 5, p555 §2.2): a card per
 * child page of the page at `<page path>` (`examples`), in menu order (`aek:order`, then label),
 * each a link with the child's `aek:image` (else its `aek:icon`), menu label and
 * `aek:description`. `featured` keeps the children with `aek:featured`, `group=<name>` those
 * with that `aek:group` (the Features page's groups). The list gets `hubCards_featured` with
 * `featured`, and `hubCards_icons` when no card has an image: the homepage's featured features
 * are icon columns, its featured examples image cards (p555 Phase 2). Every page's image is resolved before any
 * page renders (`build.ts`), so a card can show it. The directive takes no content. Out of the
 * search: each card's page has its own results.
 */

/** A card in a two-column grid of the content column (46rem): 23rem at 1x and 2x */
const CARD_IMAGE_WIDTHS = [400, 800];
const CARD_IMAGE_SIZES = '(min-width: 46rem) 23rem, 100vw';

const CARD_SOURCE_REGEX = /^[\w-]+(\/[\w-]+)*$/;

type CardFilters = { isFeatured: boolean; group: string | null };

/** The arguments after the page path; an unknown one is an error (null) */
const parseFilters = (args: string[], env: HubMarkdownEnv, line: number): CardFilters | null => {
  const filters: CardFilters = { isFeatured: false, group: null };
  for (const arg of args) {
    const groupMatch = /^group=(.+)$/.exec(arg);
    if (arg === 'featured') filters.isFeatured = true;
    else if (groupMatch) filters.group = groupMatch[1];
    else {
      env.diag.error(
        env.file,
        line,
        `::: cards: unknown argument "${arg}" (known: featured, group=<name>)`
      );
      return null;
    }
  }
  return filters;
};

const describeFilters = ({ isFeatured, group }: CardFilters) =>
  [isFeatured && 'featured', group !== null && `in the group "${group}"`]
    .filter(Boolean)
    .join(' and ');

const renderCardMedia = (page: HubPage, env: HubMarkdownEnv, line: number) => {
  const image = getPageImageSources(page, env, CARD_IMAGE_WIDTHS, line);
  if (image) {
    const size = image.width ? ` width="${image.width}" height="${image.height}"` : '';
    return {
      isImage: true,
      html: `<img class="hubCardImage" src="${image.src}" srcset="${image.srcset}" sizes="${CARD_IMAGE_SIZES}"${size} alt="" loading="lazy" decoding="async" />`,
    };
  }
  if (page.icon) {
    return {
      isImage: false,
      html: `<span class="hubCardIcon">${env.icons.render(page.icon, env.file, line)}</span>`,
    };
  }
  return { isImage: false, html: '' };
};

const renderCard = (page: HubPage, media: string, env: HubMarkdownEnv) =>
  `<li class="hubCard"><a class="hubCardLink" href="${pageHref(env.root, page)}">${media}<span class="hubCardBody"><span class="hubCardTitle">${escapeHtml(page.menu)}</span>${page.description ? `<span class="hubCardText">${escapeHtml(page.description)}</span>` : ''}</span></a></li>`;

registerHubDirective('cards', {
  open: (args, { env, line, tokens, idx }) => {
    if (tokens[idx + 1]?.type !== 'hub_directive_close') {
      env.diag.warn(env.file, line, '::: cards takes no content: it renders after the cards');
    }
    const [source = '', ...rest] = args.trim().split(/\s+/);
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
    const filters = parseFilters(rest, env, line);
    if (!filters) return '';
    const children = parent.children.filter(
      (child) =>
        child.isInMenu &&
        (!filters.isFeatured || child.isFeatured) &&
        (filters.group === null || child.group === filters.group)
    );
    if (!children.length) {
      const filtered = describeFilters(filters);
      env.diag.warn(
        env.file,
        line,
        `::: cards: hub/pages/${source}/ has no child pages${filtered ? ` ${filtered}` : ''}`
      );
      return '';
    }
    const medias = children.map((child) => renderCardMedia(child, env, line));
    const modifiers = [
      filters.isFeatured && 'hubCards_featured',
      !medias.some((media) => media.isImage) && 'hubCards_icons',
    ].filter(Boolean);
    const cards = children.map((child, i) => renderCard(child, medias[i].html, env));
    return `<ul class="${['hubCards', ...modifiers, 'hubSearchSkip'].join(' ')}">\n${cards.join('\n')}\n</ul>\n`;
  },
  close: () => '',
});
