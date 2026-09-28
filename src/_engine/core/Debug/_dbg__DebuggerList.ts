import { CMP, type TCMP } from '../../utils/CMP';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import type { DebuggerListDef, DebuggerListItem } from '../../debug/DebuggerGUI';

type MountedList = { cmp: TCMP; refresh: () => void };

/** Lists that exist (created and not yet removed), for the tab refresh. */
const mountedLists = new Set<MountedList>();
let autoIdCounter = 0;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (text: string) => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const toIdSet = (selected: string | string[] | null | undefined) =>
  new Set(selected === null || selected === undefined ? [] : [selected].flat());

/**
 * Creates the shared debugger list: rows with an optional sub title line, icon, badge and
 * title, plus optional per-row icon toggles (siblings of the row button, so a toggle click
 * never triggers the row click).
 */
export const _debuggerListCMP = (def: DebuggerListDef): TCMP => {
  const id = def.id ?? `auto${++autoIdCounter}`;
  const toggles = def.perItemConfig?.toggles || [];
  // A static array is copied, its toggle values are flipped locally
  const localData = Array.isArray(def.data)
    ? def.data.map((item) => ({ ...item, toggleValues: item.toggleValues?.slice() }))
    : null;
  const getData = () => localData || (def.data as () => DebuggerListItem[])();
  const getSelected = () => toIdSet(def.selectedItemId?.());

  let lastDataSignature = '';
  let lastSelectedSignature = '';
  let itemCount = 0;
  let rows = new Map<string, TCMP>();

  const wrapper = CMP({
    id: `debuggerList-${id}`,
    class: 'debuggerList',
    onRemoveCmp: () => mountedLists.delete(mounted),
  });
  const headingCmp = def.heading
    ? wrapper.add({
        html: () =>
          `<h4 class="debuggerListHeading">${esc(def.heading || '')} <span class="debuggerListCount">(${itemCount})</span></h4>`,
      })
    : null;
  const ul = wrapper.add({ tag: 'ul', class: 'ulList' });

  const applySelected = (selected: Set<string>) => {
    for (const [itemId, li] of rows) {
      li.updateClass('selected', selected.has(itemId) ? 'add' : 'remove');
    }
  };

  const addRow = (item: DebuggerListItem, selected: Set<string>) => {
    const values = item.toggleValues || [];
    const hasToggles = toggles.some((_, i) => typeof values[i] === 'boolean');
    const li = ul.add({
      tag: 'li',
      attr: { 'data-id': item.itemId },
      class: [
        selected.has(item.itemId) ? 'selected' : '',
        item.disabled ? 'disabledItem' : '',
        hasToggles ? 'hasToggles' : '',
      ].filter(Boolean),
    });
    rows.set(item.itemId, li);

    const onClick = def.perItemConfig?.onClick;
    li.add({
      html: `<button class="listItemWithId"${item.tooltip ? ` title="${esc(item.tooltip)}"` : ''}>
        ${item.subTitle ? `<span class="itemId">${esc(item.subTitle)}</span>` : ''}
        ${item.icon ? getSvgIcon(item.icon, 'small') : ''}
        ${item.badge ? `<span>${esc(item.badge)}</span>` : ''}
        <h4${item.titlePlaceholder ? ' style="font-style:italic"' : ''}>${esc(item.title)}</h4>
      </button>`,
      ...(onClick ? { onClick: () => onClick(item.itemId) } : {}),
    });

    if (!hasToggles) return;
    const group = li.add({ class: 'debuggerListToggles' });
    for (let i = 0; i < toggles.length; i++) {
      const toggle = toggles[i];
      const value = values[i];
      if (typeof value !== 'boolean') {
        // Keeps the other toggles aligned with the rows that have this one
        group.add({ tag: 'span', class: 'debuggerListToggleSpacer' });
        continue;
      }
      const icon = value ? toggle.icon : toggle.iconOff || toggle.icon;
      group.add({
        html: `<button class="debuggerListToggle${value ? ' isOn' : ''}" data-toggle="${i}" aria-pressed="${value}" title="${esc(toggle.title)}">${getSvgIcon(icon, 'small')}</button>`,
        onClick: (_, cmp) => {
          const hadFocus = document.activeElement === cmp.elem;
          toggle.fn(item.itemId, !value);
          if (localData) {
            const localItem = localData.find((d) => d.itemId === item.itemId);
            if (localItem?.toggleValues) localItem.toggleValues[i] = !value;
          }
          render(true);
          // The re-render replaced the button: keep the keyboard focus on the same toggle
          if (hadFocus) {
            rows.get(item.itemId)?.elem.querySelector<HTMLElement>(`[data-toggle="${i}"]`)?.focus();
          }
        },
      });
    }
  };

  /** Re-renders the rows when they changed (or `force`), otherwise only the selection. */
  const render = (force?: boolean) => {
    const items = getData();
    const selected = getSelected();
    const dataSignature = JSON.stringify(items);
    const selectedSignature = [...selected].join('\n');
    if (!force && dataSignature === lastDataSignature) {
      if (selectedSignature !== lastSelectedSignature) applySelected(selected);
      lastSelectedSignature = selectedSignature;
      return;
    }
    lastDataSignature = dataSignature;
    lastSelectedSignature = selectedSignature;

    ul.removeChildren();
    rows = new Map();
    for (let i = 0; i < items.length; i++) addRow(items[i], selected);
    if (!items.length && def.emptyText) {
      ul.add({ tag: 'li', class: 'emptyState', text: def.emptyText });
    }
    if (headingCmp && itemCount !== items.length) {
      itemCount = items.length;
      headingCmp.update();
    }
  };

  const mounted: MountedList = { cmp: wrapper, refresh: () => render() };
  mountedLists.add(mounted);
  render(true);
  return wrapper;
};

/** Refreshes the lists inside `root` (re-render only when their rows or selection changed). */
export const _refreshDebuggerLists = (root: HTMLElement) => {
  for (const list of mountedLists) {
    if (root.contains(list.cmp.elem)) list.refresh();
  }
};
