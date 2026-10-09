import type { TCMP } from '../../utils/CMP';
import { CMP, classes } from '../../utils/CMP';
import './DropDown.scss';

export type DropDownOption = { value: string; label: string };

type ClassProp = string | string[];

export type DropDownProps = {
  /** The options, or a getter re-read on every open (and refresh). */
  options: DropDownOption[] | (() => DropDownOption[]);
  /** The current value: the trigger shows its label, and the list opens on it and marks it. A
   * getter is re-read on every open (and refresh). */
  value?: string | null | (() => string | null);
  /** A picked option, also the current one (the handler decides what that does). */
  onChange: (value: string) => void;
  /** The trigger's text when no option matches the value. */
  placeholder?: string;
  /** Raw HTML of the trigger's icon (eg. `getSvgIcon('camera', 'small')`). */
  icon?: string;
  /** The trigger's tooltip and the list's accessible name. */
  title?: string;
  /** Which side of the trigger the list opens on. Default 'bottom'. */
  placement?: 'top' | 'bottom';
  disabled?: boolean;
  /** Extra classes. The default styles (DropDown.scss) have zero specificity (`:where()`), so
   * any class overrides them; the elements also carry the global `aekDropDown*` classes. */
  className?: ClassProp;
  triggerClass?: ClassProp;
  labelClass?: ClassProp;
  listClass?: ClassProp;
  itemClass?: ClassProp;
  onOpen?: () => void;
  onClose?: () => void;
};

export type TDropDown = {
  /** The dropdown's root (the trigger, and the list while it is open). */
  cmp: TCMP;
  /** Opens the list on the current value and focuses it. */
  open: () => void;
  /** Closes the list without a change. */
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  /** Re-reads the value (and options) into the trigger's label. */
  refresh: () => void;
};

const ROOT_CLASS = 'aekDropDown';
const TRIGGER_CLASS = 'aekDropDownTrigger';
const LABEL_CLASS = 'aekDropDownLabel';
const CARET_CLASS = 'aekDropDownCaret';
const LIST_CLASS = 'aekDropDownList';
const ITEM_CLASS = 'aekDropDownItem';
const HIGHLIGHTED_CLASS = 'isHighlighted';
const CURRENT_CLASS = 'isCurrent';
const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

const resolve = <T>(value: T | (() => T)) =>
  typeof value === 'function' ? (value as () => T)() : value;

/** Swallows the keyup of the key that closed a list, so a KEY_UP binding of that key (eg. an
 * app's Escape) doesn't fire right after. */
const swallowNextKeyUp = (key: string) => {
  const onKeyUp = (e: KeyboardEvent) => {
    window.removeEventListener('keyup', onKeyUp, true);
    if (e.key === key) e.stopImmediatePropagation();
  };
  window.addEventListener('keyup', onKeyUp, true);
};

/**
 * Creates a dropdown: a trigger button with an icon, the current option's label and a caret, and
 * an in-page list (not a native select: a native list owns the keyboard while it is open, and
 * Chrome on Windows commits the highlighted option when it is closed with Escape).
 * A click on the trigger toggles the list. In the list, arrow keys, Home and End move, Enter,
 * Space or a click picks, and Escape, Tab or a click outside closes it without a change. The
 * list's keys reach no key binding (their keyups included).
 * @param props (object) {@link DropDownProps}
 */
export const createDropDown = (props: DropDownProps): TDropDown => {
  const placement = props.placement || 'bottom';
  let list: TCMP | null = null;

  const getOptions = () => resolve(props.options);
  const getValue = () => resolve(props.value ?? null);

  const root = CMP({
    class: classes(ROOT_CLASS, `${ROOT_CLASS}_${placement}`, props.className),
    onRemoveCmp: () => {
      list = null;
    },
  });

  const trigger = CMP({
    html: () => `<button type="button" class="${classes(TRIGGER_CLASS, props.triggerClass).join(' ')}"${props.disabled ? ' disabled' : ''}>
  ${props.icon || ''}
  <span class="${classes(LABEL_CLASS, props.labelClass).join(' ')}"></span>
  <span class="${CARET_CLASS}"></span>
</button>`,
    attr: {
      ...(props.title ? { title: props.title } : {}),
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    },
    // Not focused by the press: an open list's focusout would close it before the click, which
    // would then reopen it instead of closing it
    listeners: [{ type: 'mousedown', fn: (e) => e.preventDefault() }],
    onClick: (e) => {
      e.stopPropagation();
      toggle();
    },
  });
  root.add(trigger);
  const labelElem = trigger.elem.querySelector(`.${LABEL_CLASS}`);

  const refresh = () => {
    const value = getValue();
    // Text, not HTML: labels often come from app data
    if (labelElem) {
      labelElem.textContent =
        getOptions().find((option) => option.value === value)?.label ?? props.placeholder ?? '';
    }
  };

  const close = () => {
    const openList = list;
    list = null; // first: removing the focused list fires its focusout
    if (!openList) return;
    trigger.updateAttr({ 'aria-expanded': 'false' });
    openList.remove();
    props.onClose?.();
  };

  const open = () => {
    if (list || props.disabled) return;
    const options = getOptions();
    if (!options.length) return;
    const currentValue = getValue();
    let index = Math.max(
      0,
      options.findIndex((option) => option.value === currentValue)
    );

    const newList: TCMP = CMP({
      tag: 'ul',
      class: classes(LIST_CLASS, props.listClass),
      attr: {
        role: 'listbox',
        tabindex: '-1',
        ...(props.title ? { 'aria-label': props.title } : {}),
      },
      onClick: (e) => {
        e.stopPropagation();
        const item = (e.target as HTMLElement).closest('li');
        if (item) choose(Number(item.dataset.index));
      },
      listeners: [
        // Keeps the focus in the list on a click, so the click lands before any focusout
        { type: 'mousedown', fn: (e) => e.preventDefault() },
        { type: 'keydown', fn: (e) => onKeyDown(e as KeyboardEvent) },
        {
          type: 'keyup',
          fn: (e) => {
            if (NAV_KEYS.has((e as KeyboardEvent).key)) e.stopPropagation();
          },
        },
        {
          type: 'mousemove',
          fn: (e) => {
            const item = (e.target as HTMLElement).closest('li');
            if (item && Number(item.dataset.index) !== index) highlight(Number(item.dataset.index));
          },
        },
        {
          type: 'focusout',
          fn: (e) => {
            const next = (e as FocusEvent).relatedTarget as Node | null;
            if (!next || !newList.elem.contains(next)) close();
          },
        },
      ],
    });

    const highlight = (newIndex: number) => {
      index = Math.min(options.length - 1, Math.max(0, newIndex));
      const items = newList.elem.children;
      for (let i = 0; i < items.length; i++) {
        items[i].classList.toggle(HIGHLIGHTED_CLASS, i === index);
      }
      items[index]?.scrollIntoView({ block: 'nearest' });
      newList.updateAttr({ 'aria-activedescendant': `${newList.id}-${index}` });
    };

    const choose = (chosenIndex: number) => {
      close();
      props.onChange(options[chosenIndex].value);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'ArrowDown') highlight(index + 1);
      else if (e.key === 'ArrowUp') highlight(index - 1);
      else if (e.key === 'Home') highlight(0);
      else if (e.key === 'End') highlight(options.length - 1);
      else if (e.key === 'Enter' || e.key === ' ') {
        swallowNextKeyUp(e.key);
        choose(index);
      } else if (e.key === 'Escape') {
        swallowNextKeyUp(e.key);
        close();
      } else if (e.key === 'Tab') {
        close();
        return;
      } else return; // Other keys go on (eg. a shortcut that toggles this list)
      // The list's keys reach no key binding
      e.preventDefault();
      e.stopPropagation();
    };

    for (let i = 0; i < options.length; i++) {
      const isCurrent = options[i].value === currentValue;
      newList.add({
        tag: 'li',
        text: options[i].label,
        class: classes(ITEM_CLASS, isCurrent ? CURRENT_CLASS : null, props.itemClass),
        attr: {
          id: `${newList.id}-${i}`,
          role: 'option',
          'aria-selected': String(isCurrent),
          'data-index': String(i),
        },
      });
    }

    root.add(newList);
    list = newList;
    trigger.updateAttr({ 'aria-expanded': 'true' });
    highlight(index);
    newList.elem.focus({ preventScroll: true });
    props.onOpen?.();
  };

  const toggle = () => (list ? close() : open());

  refresh();

  return { cmp: root, open, close, toggle, isOpen: () => Boolean(list), refresh };
};
