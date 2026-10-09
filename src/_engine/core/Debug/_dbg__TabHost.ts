import { CMP, type TCMP } from '../../utils/CMP';
import styles from './DebuggerGUI.module.scss';
import { lsRemoveItem } from '../../utils/LocalAndSessionStorage';
import { lerror } from '../../utils/Logger';
import type { AnyDebuggerTabDef } from '../../debug/DebuggerGUI';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { _buildDebuggerPane } from './_dbg__DebuggerPaneBuilder';
import { _refreshDebuggerLists } from './_dbg__DebuggerList';

export type TabHostOpts = {
  /** The element the mounted tab's content goes in, which is also its scroller. Re-read on every
   * use, because the owner may rebuild it (the drawer, a window's content). */
  getContainer: () => TCMP | null;
  /** Whether the host can be seen (eg. the drawer is open). A tab's `refreshIntervalMs` runs only
   * while it can. */
  isVisible: () => boolean;
  /** Runs after a tab's content is mounted (eg. to select its menu button). */
  onMount?: (def: AnyDebuggerTabDef) => void;
  /** Error log prefix. Default 'Debugger tab'. */
  label?: string;
};

export type TabHost = {
  /** Replaces the container's content with this tab's fresh content. */
  mount: (def: AnyDebuggerTabDef) => void;
  /** Refreshes the mounted tab's content (panes, lists and CMP sections with an `html`
   * function), or with `rebuild` mounts it again, keeping the scroll position. */
  refresh: (rebuild?: boolean) => void;
  /** Runs the mounted tab's lifecycle cleanup. The DOM/CMP removal is up to the owner. */
  unmount: () => void;
  /** The host became visible: refreshes the mounted tab (it wasn't refreshed while hidden) and
   * starts its refresh interval. */
  resume: () => void;
  /** The host was hidden: stops the mounted tab's refresh interval. */
  pause: () => void;
  /** The mounted tab's id, or null. */
  readonly mountedId: string | null;
};

/** The tab whose content is currently in the container. */
type MountedTab = {
  def: AnyDebuggerTabDef;
  /** Refresh function of each content section. */
  sectionRefreshers: (() => void)[];
  onOpenCleanup: (() => void) | null;
  intervalId: ReturnType<typeof setInterval> | null;
};

/**
 * Creates a tab host: the lifecycle of one mounted debugger tab ({@link AnyDebuggerTabDef}) in a
 * container. It builds the heading row and the sections, refreshes them, runs `onOpen` and its
 * cleanup, and runs `refreshIntervalMs` only while the host is visible. The owner keeps its own
 * menu, ordering and state (the debug drawer and the profiler window each use one host).
 * @param opts ({@link TabHostOpts})
 * @returns {@link TabHost}
 */
export const createTabHost = (opts: TabHostOpts): TabHost => {
  const { getContainer, isVisible, onMount, label = 'Debugger tab' } = opts;
  let mountedTab: MountedTab | null = null;

  const runOnRefresh = (def: AnyDebuggerTabDef) => {
    try {
      def.onRefresh?.();
    } catch (err) {
      lerror(`${label} "${def.id}" onRefresh failed`, err);
    }
  };

  /** Builds a tab: container with the heading row, then the content sections. */
  const buildTabContent = (def: AnyDebuggerTabDef) => {
    const container = CMP({ id: `debuggerPane-${def.id}`, class: styles.childContainer });

    const headingRow = container.add({ class: 'debuggerTabHeadingRow' });
    const icon = getSvgIcon(def.icon);
    headingRow.add({ html: () => `<h3>${icon} ${def.title}</h3>`, class: 'debuggerTabHeading' });
    const lsKey = def.lsKey;
    if (def.clearLSButton ?? Boolean(lsKey)) {
      headingRow.add(
        createClearTabLSButton({
          hasData: () => (lsKey ? lsKeyHasData(lsKey) : false),
          onClear: () => {
            if (!lsKey) return;
            lsRemoveItem(lsKey);
            def.onClearLS?.();
          },
          watchKey: lsKey,
        })
      );
    }
    const headerButtons = def.headerButtons?.() || [];
    for (let i = 0; i < headerButtons.length; i++) headingRow.add(headerButtons[i]);

    runOnRefresh(def);
    const sections = def.content();
    const sectionRefreshers: (() => void)[] = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if ('isCmp' in section) {
        container.add(section);
        // Only a dynamic template has anything to refresh (a static CMP is left alone), and it is
        // only re-rendered when its html changed (a re-render replaces the element: hover, focus)
        const html = section.props?.html;
        if (typeof html === 'function') {
          let lastHtml = html(section);
          sectionRefreshers.push(() => {
            const nextHtml = html(section);
            if (nextHtml === lastHtml) return;
            lastHtml = nextHtml;
            section.update();
          });
        }
        continue;
      }
      const built = _buildDebuggerPane(def, section);
      container.add(built.cmp);
      sectionRefreshers.push(built.refresh);
    }

    return { container, sectionRefreshers };
  };

  const refreshMountedTab = () => {
    if (!mountedTab) return;
    runOnRefresh(mountedTab.def);
    const refreshers = mountedTab.sectionRefreshers;
    for (let i = 0; i < refreshers.length; i++) refreshers[i]();
    const container = getContainer();
    if (container) _refreshDebuggerLists(container.elem);
  };

  const startInterval = () => {
    if (!mountedTab || mountedTab.intervalId !== null || !isVisible()) return;
    const intervalMs = mountedTab.def.refreshIntervalMs;
    if (!intervalMs) return;
    mountedTab.intervalId = setInterval(() => {
      if (isVisible()) refreshMountedTab();
    }, intervalMs);
  };

  const stopInterval = () => {
    if (!mountedTab || mountedTab.intervalId === null) return;
    clearInterval(mountedTab.intervalId);
    mountedTab.intervalId = null;
  };

  const unmount = () => {
    if (!mountedTab) return;
    stopInterval();
    const cleanup = mountedTab.onOpenCleanup;
    const id = mountedTab.def.id;
    mountedTab = null;
    try {
      cleanup?.();
    } catch (err) {
      lerror(`${label} "${id}" onOpen cleanup failed`, err);
    }
  };

  const mount = (def: AnyDebuggerTabDef) => {
    const hostContainer = getContainer();
    if (!hostContainer) return;
    unmount();
    hostContainer.removeChildren();

    const { container, sectionRefreshers } = buildTabContent(def);
    hostContainer.add(container);

    mountedTab = { def, sectionRefreshers, onOpenCleanup: null, intervalId: null };
    onMount?.(def);
    if (def.onOpen) {
      try {
        mountedTab.onOpenCleanup = def.onOpen() || null;
      } catch (err) {
        lerror(`${label} "${def.id}" onOpen failed`, err);
      }
    }
    startInterval();
  };

  const refresh = (rebuild?: boolean) => {
    if (!rebuild) {
      refreshMountedTab();
      return;
    }
    const container = getContainer();
    if (!mountedTab || !container) return;
    const scrollPos = container.elem.scrollTop;
    mount(mountedTab.def);
    container.elem.scrollTop = scrollPos;
  };

  return {
    mount,
    refresh,
    unmount,
    resume: () => {
      refreshMountedTab();
      startInterval();
    },
    pause: stopInterval,
    get mountedId() {
      return mountedTab?.def.id ?? null;
    },
  };
};
