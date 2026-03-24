import * as THREE from 'three/webgpu';

type SetTimeout = ReturnType<typeof setTimeout>;

let rootCMP: TCMP | null = null;
const cmps: { [key: string]: TCMP } = {};
const cmpWrappers: {
  [key: string]: {
    wrapper: (props?: unknown) => TCMP;
    wrapperProps?: unknown;
  };
} = {};
const setWrapper = (id: string, wrapper: (props?: unknown) => TCMP, wrapperProps?: unknown) =>
  (cmpWrappers[id] = { wrapper: wrapper, wrapperProps });
const getWrapper = <WrapP = undefined>(id: string) =>
  cmpWrappers[id] as { wrapper: (props?: WrapP) => TCMP; wrapperProps?: WrapP };
const removeWrapper = (id: string) => {
  if (cmpWrappers[id]) delete cmpWrappers[id];
};

export type TListener = (e: Event | InputEvent, cmp: TCMP) => void;

export type TListenerCreator = {
  type: string;
  fn: ((e: Event, cmp: TCMP) => void) | null;
  options?: AddEventListenerOptions;
};

export type TListenerCache = {
  type: string;
  fn: ((e: Event) => void) | null;
  options?: AddEventListenerOptions;
};

export type TClassAction = 'add' | 'remove' | 'replace' | 'toggle';

export type TStyle = { [key: string]: string | number | null };

export type TAttr = { [key: string]: unknown };

export type TAnimState = {
  setState: (key: string, value: unknown) => void;
  removeState: (key: string) => void;
  state: { [key: string]: unknown };
};

export type TAnimChain = {
  duration: number;
  gotoIndex?: number | ((cmp: TCMP, animState?: TAnimState) => number);
  style?: TStyle;
  class?: string | string[];
  classAction?: TClassAction;
  phaseStartFn?: (cmp: TCMP, animState: TAnimState) => void | number;
  phaseEndFn?: (cmp: TCMP, animState: TAnimState) => void | number;
};

export type TSettings = {
  sanitizer?: ((html: string) => string) | null;
  sanitizeAll?: boolean;
  doCheckIsInDom?: boolean;
  replaceRootDom?: boolean;
};

export type TProps = {
  /** Lighter settings can only be set when the
   * root component is defined.
   */
  settings?: TSettings;

  /** Component ID. If no component is provided
   * a UUID will be created. Has to be unique.
   */
  id?: string;

  /** Whether the component elem will get an id
   * attribute or not.
   */
  idAttr?: boolean;

  /** Root component's attach to element. */
  attach?: HTMLElement;

  /** Element text content. */
  text?: string;

  /** Instead of append, prepend the element to the parent */
  prepend?: boolean;

  /** Component element's tag. */
  tag?: string;

  /** Component's html content. The string can
   * include other components by inserting them
   * in the string template (back ticks strings).
   */
  html?: string | ((cmp: TCMP) => string);

  /** Whether to sanitize the html content. A
   * sanitizer function must be set in the root
   * component's settings.
   */
  sanitize?: boolean;

  /** Component element's class or classes.  */
  class?: string | string[];

  /** Component element's attributes. */
  attr?: TAttr;

  /** Component element's inline styles. */
  style?: TStyle;

  /** Timeout animation array. */
  anim?: TAnimChain[];

  /** Component element's 'click' listener function. */
  onClick?: TListener;

  /** Component element's outside click listener function.
   * One window click listener for all components.
   */
  onClickOutside?: TListener;

  /** Component element's 'mousemove' listener function. */
  onHover?: TListener;

  /** Component element's 'mouseleave' listener function. */
  onHoverOutside?: TListener;

  /** Component element's 'focus' listener function. */
  onFocus?: TListener;

  /** Component element's 'blur' listener function. */
  onBlur?: TListener;

  /** Component element's 'input' listener function. */
  onInput?: TListener;

  /** Component element's 'change' listener function. */
  onChange?: TListener;

  /** Callback function after the component has been
   * created / updated.
   */
  onCreateCmp?: (cmp: TCMP) => void;

  /** Callback function after the component has been removed. */
  onRemoveCmp?: (cmp: TCMP) => void;

  /** Component element's listener creator. Will create
   * a Javascript event listener with 'type', 'fn' (function),
   * and 'options'.
   */
  listeners?: TListenerCreator[];

  /** Whether the element should have focus after render
   * or not (this can be sometimes challenging, so using
   * the focus function on the component after render is
   * recommended).
   */
  focus?: boolean;

  // @TODO
  /** Component's on resize listener. One window resize
   * listener for all components.
   */
  // onWindowResize?: TListener; // This is going to be the same as onClickOutside
};

export type TCMP = {
  id: string;
  children: TCMP[];
  props?: TProps;
  elem: HTMLElement;
  parent: TCMP | null;
  parentElem: HTMLElement | null;
  isTemplateCmp?: boolean;
  isRoot?: boolean;
  isCmp: boolean;
  listeners: { [key: string]: TListenerCache | null };
  timers: { [key: string]: { fn: unknown; curIndex?: number; animState?: TAnimState } };
  add: (child?: TCMP | TProps) => TCMP;
  remove: () => TCMP;
  removeChildren: () => TCMP;
  update: <WrapP extends TProps>(newProps?: WrapP, callback?: (cmp: TCMP) => void) => TCMP;
  updateClass: (newClass: string | string[], action?: TClassAction) => TCMP;
  updateAttr: (newAttr: TAttr) => TCMP;
  removeAttr: (attrKey: string | string[]) => TCMP;
  updateStyle: (newStyle: TStyle) => TCMP;
  updateText: (newText: string) => TCMP;
  updateAnim: (animChain: TAnimChain[]) => TCMP;
  focus: (focusValueToProps?: boolean) => TCMP;
  blur: (focusValueToProps?: boolean) => TCMP;
  scrollIntoView: (params?: boolean | ScrollIntoViewOptions, timeout?: number) => TCMP;
  getWrapperProps: <WrapP = undefined>() => WrapP | null;
  controls: { [key: string]: unknown };
  // @SUGGESTION:
  // updateListener: (TListenerCreator) => TCMP;
  // removeListener: (key: string) => TCMP;
  // removeAllListeners: () => TCMP;
  // removeTimer: (key: string) => TCMP;
  // removeAllTimers: () => TCMP;
  // getChildCmpById: (id: string) => TCMP;
  // getParentCmpById: (id: string) => TCMP;
};

const globalSettings: TSettings = {
  sanitizer: null,
  sanitizeAll: false,
  doCheckIsInDom: false,
  replaceRootDom: true,
};

/**
 * Creates and renders a CMP
 * @param props ({@link TProps}) optional component props
 * @param wrapper ((props?: never) => {@link TCMP} | (props: never) => TCMP) optional wrapper for the CMP to attach to
 * @param wrapperProps (unknown) optional wrapper props to set when a wrapper is used
 * @returns ({@link TCMP})
 */
export const CMP = (
  props?: TProps,
  wrapper?: ((props?: never) => TCMP) | ((props: never) => TCMP),
  wrapperProps?: unknown
): TCMP => {
  if (props?.attach && rootCMP) {
    throw new Error('Root node already created');
  }
  if (props?.id && cmps[props.id]) {
    throw new Error(`Id is already in use / taken: ${props.id}`);
  }

  const id = props?.id || THREE.MathUtils.generateUUID();

  // Create cmp object
  const cmp: TCMP = {
    id,
    children: [],
    props,
    elem: null as unknown as HTMLElement,
    parent: null,
    parentElem: null,
    isCmp: true,
    listeners: {},
    timers: {},
    add: (child) => addChildCmp(cmp, child),
    remove: () => removeCmp(cmp),
    removeChildren: () => removeCmpChildren(cmp),
    update: <WrapP extends TProps>(newProps?: TProps | WrapP, callback?: (cmp: TCMP) => void) =>
      updateCmp<WrapP>(cmp, newProps, callback),
    updateClass: (newClass, action) => updateCmpClass(cmp, newClass, action),
    updateAttr: (newAttr) => updateCmpAttr(cmp, newAttr),
    removeAttr: (attrKey) => removeCmpAttr(cmp, attrKey),
    updateStyle: (newStyle: TStyle) => updateCmpStyle(cmp, newStyle),
    updateText: (newText) => updateCmpText(cmp, newText),
    updateAnim: (animChain: TAnimChain[]) => updateCmpAnim(cmp, animChain),
    focus: (focusValueToProps) => focusCmp(cmp, focusValueToProps),
    blur: (focusValueToProps) => blurCmp(cmp, focusValueToProps),
    scrollIntoView: (params, timeout) => scrollCmpIntoView(cmp, params, timeout),
    getWrapperProps: <WrapP>(): WrapP | null => getWrapper<WrapP>(id)?.wrapperProps || null,
    controls: {},
  };

  // Create possible wrapper
  if (wrapper) setWrapper(id, wrapper as (props?: unknown) => TCMP, wrapperProps);

  // Create new element
  const elem = createElem(cmp, props);
  cmp.elem = elem;

  // Create possible listeners
  const listeners = createListeners(cmp, props);
  cmp.listeners = listeners;

  // Check if props have attach and attach to element
  if (props?.attach) {
    if (props?.settings?.sanitizer) globalSettings.sanitizer = props?.settings.sanitizer;
    if (props?.settings?.sanitizeAll) globalSettings.sanitizeAll = props?.settings.sanitizeAll;
    if (props?.settings?.doCheckIsInDom !== undefined)
      globalSettings.doCheckIsInDom = props?.settings.doCheckIsInDom;
    if (props?.settings?.replaceRootDom !== undefined)
      globalSettings.replaceRootDom = props?.settings.replaceRootDom;
    if (globalSettings.replaceRootDom) {
      props.attach.replaceWith(elem);
    } else {
      props.prepend ? props.attach.prepend(elem) : props.attach.appendChild(elem);
    }
    rootCMP = cmp;
    cmp.parentElem = elem.parentElement;
    cmp.parent = null;
    cmp.isRoot = true;
    runAnims(cmp);
  }

  // Add cmp to list
  cmps[id] = cmp;

  // Check for child <cmp> tags and replace possible tempTemplates
  addTemplateChildCmp(cmp);

  // Overwrite toString method
  cmp.toString = () => getTempTemplate(id);

  return cmp as TCMP;
};

const addChildCmp = (parent: TCMP, child?: TCMP | TProps) => {
  let cmp;
  if (!child) {
    cmp = CMP();
  } else if (!('isCmp' in child)) {
    cmp = CMP(child);
  } else {
    cmp = child;
  }

  parent.children.push(cmp);
  const prepend = cmp.props?.prepend;
  prepend ? parent.elem.prepend(cmp.elem) : parent.elem.appendChild(cmp.elem);
  cmp.parent = parent;
  cmp.parentElem = parent.elem;
  if (cmp.props?.focus) focusCmp(cmp);
  runAnims(cmp);
  if (cmp.props?.onCreateCmp) cmp.props.onCreateCmp(cmp);
  return cmp;
};

const addTemplateChildCmp = (cmp: TCMP) => {
  let focusComponent: TCMP | null = null;
  const childCmpElems = cmp.elem.querySelectorAll('cmp');
  for (let i = 0; i < childCmpElems.length; i++) {
    const id = childCmpElems[i].getAttribute('id');
    if (id && childCmpElems[i].outerHTML === getTempTemplate(id)) {
      const replaceWithCmp = cmps[id];
      if (!replaceWithCmp) {
        throw new Error(
          `The replaceWithCmp not found in cmps list (parent cmp: ${cmp.id}, replaceWithCmp id: ${id})`
        );
      }
      childCmpElems[i].replaceWith(replaceWithCmp.elem);
      replaceWithCmp.isTemplateCmp = true;
      replaceWithCmp.parent = cmp;
      replaceWithCmp.parentElem = cmp.elem;
      if (replaceWithCmp.props?.focus) focusComponent = replaceWithCmp;
      cmp.children.push(replaceWithCmp);
      runAnims(replaceWithCmp);
      if (cmp.props?.onCreateCmp) cmp.props.onCreateCmp(cmp);
    }
  }
  if (focusComponent) setTimeout(() => focusComponent && focusCmp(focusComponent), 0);
};

/**
 * Returns a CMP depending on the id
 * @param id (string) CMP id
 * @returns ({@link TCMP} | null)
 */
export const getCmpById = (id: string): TCMP | null => cmps[id] || null;

/**
 * Creates a new id in the form of c-[uuid]
 * @returns (string)
 */
export const createNewId = () => `c-${THREE.MathUtils.generateUUID()}`;

const getTempTemplate = (id: string, tag: string = 'cmp') => `<${tag} id="${id}"></${tag}>`;

const createElem = (cmp: TCMP, props?: TProps) => {
  let elem;

  // Elem and content
  if (props?.html) {
    if (typeof props.html === 'string' && props.html.includes('</cmp>')) {
      throw new Error(
        'CMP html prop must be a function definition when it has inline CMPs defined (now it is a string). For example: \n\nconst html = () => `Icon ${Icon()}`;\nconst myComponent = CMP({ html }});\n'
      );
    }
    const template = document.createElement('template');
    const rawHtml = typeof props.html === 'string' ? props.html : props.html(cmp);
    template.innerHTML =
      (props.sanitize || globalSettings.sanitizeAll) && globalSettings.sanitizer
        ? globalSettings.sanitizer(rawHtml)
        : rawHtml;
    elem = template.content.children[0] as HTMLElement;
    // Check if element is a <cmp> element and replace it with the actual CMP,
    // this is achieved when the props have this: { html: () => `CMP({ text: something })` }
    if (elem.outerHTML.startsWith('<cmp')) {
      const cmpId = elem.getAttribute('id');
      if (cmpId) {
        const replaceWithCmp = cmps[cmpId];
        if (replaceWithCmp?.elem) {
          elem = replaceWithCmp.elem;
          cmp.children.push(replaceWithCmp);
          replaceWithCmp.parent = cmp;
        }
      }
    }
    setPropsValue(cmp, { tag: elem.tagName.toLowerCase() });
  } else {
    elem = document.createElement(props?.tag ? props.tag : 'div') as HTMLElement;
  }
  if (props?.text) elem.textContent = props?.text;

  const attrKeys = props?.attr ? Object.keys(props.attr) : [];
  const attributes = props?.attr || {};
  for (let i = 0; i < attrKeys.length; i++) {
    const value = attributes[attrKeys[i]];
    elem.setAttribute(attrKeys[i], String(value));
  }
  if (props?.idAttr) elem.setAttribute('id', cmp.id);

  // Classes
  let classes: string[] = [];
  if (props?.class && Array.isArray(props.class)) {
    classes = props.class;
  } else if (props?.class && typeof props?.class === 'string') {
    classes = props.class.split(' ');
  }
  for (let i = 0; i < classes.length; i++) {
    classes[i] && elem.classList.add(classes[i].trim());
  }

  // Styles
  if (props?.style) {
    const styleProps = Object.keys(props.style);
    for (let i = 0; i < styleProps.length; i++) {
      const prop = styleProps[i];
      const value = props.style[styleProps[i]];
      if (prop && value !== null) {
        // @TODO: test if null values remove the rule?
        elem.style[prop as unknown as number] = String(value);
      } else if (value === null) {
        elem.style.removeProperty(prop);
      }
    }
  }

  return elem;
};

const createListeners = (cmp: TCMP, props?: TProps) => {
  // Remove possiple listeners
  removeListeners(cmp, true);

  const listeners = cmp.listeners;

  if (props?.onClick) {
    // Add "click" listener
    const onClick = props.onClick;
    const fn = (e: Event) => onClick(e, cmp);
    listeners.click = { fn, type: 'click' };
    cmp.elem.addEventListener('click', fn, true);
  } else {
    if (listeners.click || listeners.click === null) delete listeners.click;
  }
  // Add "outsideClick" listener
  createOutsideClickListener(cmp);
  if (props?.onHover) {
    // Add "mousemove" listener
    const onHover = props.onHover;
    const fn = (e: Event) => onHover(e, cmp);
    listeners.mousemove = { fn, type: 'mousemove' };
    cmp.elem.addEventListener('mousemove', fn, true);
  } else {
    if (listeners.mousemove || listeners.mousemove === null) delete listeners.mousemove;
  }
  if (props?.onHoverOutside) {
    // Add "mouseleave" listener
    const onHoverOutside = props.onHoverOutside;
    const fn = (e: Event) => onHoverOutside(e, cmp);
    listeners.mouseleave = { fn, type: 'mouseleave' };
    cmp.elem.addEventListener('mouseleave', fn, true);
  } else {
    if (listeners.mouseleave || listeners.mouseleave === null) delete listeners.mouseleave;
  }
  if (props?.onFocus) {
    // Add "focus" listener
    const onFocus = props.onFocus;
    const fn = (e: Event) => onFocus(e, cmp);
    listeners.focus = { fn, type: 'focus' };
    cmp.elem.addEventListener('focus', fn, true);
  } else {
    if (listeners.focus || listeners.focus === null) delete listeners.focus;
  }
  if (props?.onBlur) {
    // Add "blur" listener
    const onBlur = props.onBlur;
    const fn = (e: Event) => onBlur(e, cmp);
    listeners.blur = { fn, type: 'blur' };
    cmp.elem.addEventListener('blur', fn, true);
  } else {
    if (listeners.blur || listeners.blur === null) delete listeners.blur;
  }
  if (props?.onInput) {
    // Add "input" listener
    const onInput = props.onInput;
    const fn = (e: Event) => onInput(e, cmp);
    listeners.input = { fn, type: 'input' };
    cmp.elem.addEventListener('input', fn, true);
  } else {
    if (listeners.input || listeners.input === null) delete listeners.input;
  }
  if (props?.onChange) {
    // Add "change" listener
    const onChange = props.onChange;
    const fn = (e: Event) => onChange(e, cmp);
    listeners.change = { fn, type: 'change' };
    cmp.elem.addEventListener('change', fn, true);
  } else {
    if (listeners.change || listeners.change === null) delete listeners.change;
  }
  if (props?.listeners) {
    // Add custom listeners
    for (let i = 0; i < props.listeners.length; i++) {
      const listenerFn = props.listeners[i].fn;
      if (!listenerFn) continue;
      const fn = (e: Event) => listenerFn(e, cmp);
      const type = props.listeners[i].type;
      listeners[type] = {
        fn,
        type,
        ...(props.listeners[i].options ? { options: props.listeners[i].options } : {}),
      };
      cmp.elem.addEventListener(type, fn, true);
    }
  }
  return listeners;
};

const removeListeners = (cmp: TCMP, nullify?: boolean) => {
  const listeners = cmp.listeners;
  const keys = Object.keys(listeners);

  // Remove possiple listeners
  for (let i = 0; i < keys.length; i++) {
    const listener = listeners[keys[i]];
    if (listener?.fn) {
      cmp.elem.removeEventListener(keys[i], listener.fn, true);
      if (nullify) listeners[keys[i]] = null;
    }
  }

  if (cmp.props?.onClickOutside) removeOutsideClickListener(cmp);
};

const removeCmp = (cmp: TCMP, doNotRemoveElem?: boolean) => {
  const id = cmp.id;

  // Remove children CMPs
  removeCmpChildren(cmp);

  // Remove reference from parent
  if (cmp.parent?.children.length) {
    cmp.parent.children = cmp.parent.children.filter((child) => child.id !== id);
  }

  // Remove possible wrapper
  removeWrapper(cmp.id);

  // Remove elem from dom and cmps
  removeListeners(cmp, true);
  removeAnims(cmp);
  if (!doNotRemoveElem) {
    cmp.elem.remove();
  }
  delete cmps[cmp.id];

  if (cmp.props?.onRemoveCmp) cmp.props.onRemoveCmp(cmp);

  return cmp;
};

const removeCmpChildren = (cmp: TCMP) => {
  const children = cmp.children;
  for (let i = 0; i < children.length; i++) {
    children[i].remove();
  }
  return cmp;
};

const updateCmp = <WrapP extends TProps>(
  cmp: TCMP,
  newProps?: TProps | WrapP,
  callback?: (cmp: TCMP) => void
) => {
  const wrapper = getWrapper<WrapP>(cmp.id);
  if (wrapper) {
    // Wrapper component type
    const template = document.createElement('template');
    template.innerHTML = getTempTemplate(cmp.id, 'cmpw');
    const tempElem = template.content.children[0] as HTMLElement;
    removeListeners(cmp, true);
    cmp.elem.replaceWith(tempElem);
    if (cmp.props?.attach) rootCMP = null;
    const wrapperProps = wrapper.wrapperProps && {
      ...wrapper.wrapperProps,
      ...newProps,
    };
    setWrapper(cmp.id, wrapper.wrapper as (props?: unknown) => TCMP, wrapperProps);
    cmp.removeChildren();
    delete cmps[cmp.id];
    const newCmp = wrapper.wrapper(wrapperProps);
    replaceCmpWithAnother(cmp, newCmp);
    if (cmp.props?.attach) rootCMP = cmp;
    tempElem.replaceWith(cmp.elem);
  } else {
    // Added or template component type
    removeListeners(cmp, true);
    cmp.props = { ...cmp.props, ...newProps };
    const elem = createElem(cmp, cmp.props);
    cmp.elem.replaceWith(elem);
    cmp.elem = elem;
    // Remove old templateCmp children and added children
    const keepAddedChildren = [];
    for (let i = 0; i < cmp.children.length; i++) {
      const child = cmp.children[i];
      if (!child.isTemplateCmp) {
        keepAddedChildren.push(child);
      }
      child.remove();
    }
    cmp.children = [];
    // Add added children
    for (let i = 0; i < keepAddedChildren.length; i++) {
      cmp.add(keepAddedChildren[i]);
    }
  }
  const listeners = createListeners(cmp, cmp.props);
  cmp.listeners = listeners;
  if (cmp.props?.focus) focusCmp(cmp);
  addTemplateChildCmp(cmp);
  runAnims(cmp);
  if (cmp.props?.onCreateCmp) cmp.props.onCreateCmp(cmp);
  if (callback) callback(cmp);
  return cmp;
};

const updateCmpClass = (
  cmp: TCMP,
  newClass: string | string[],
  action: TClassAction = 'replace'
) => {
  let classes: string[] = [];
  let oldClasses: string[] = [];
  if (Array.isArray(newClass)) {
    classes = newClass;
  } else if (newClass) {
    classes = newClass.split(' ');
  }
  if (cmp.props?.class && Array.isArray(cmp.props.class)) {
    oldClasses = cmp.props.class;
  } else if (typeof cmp.props?.class === 'string') {
    oldClasses = cmp.props.class.split(' ');
  }
  if (action === 'remove') {
    // Remove
    for (let i = 0; i < classes.length; i++) {
      oldClasses = oldClasses.filter((c) => c !== classes[i].trim());
      cmp.elem.classList.remove(classes[i].trim());
    }
    setPropsValue(cmp, { class: oldClasses.join(' ').trim().split(' ') });
  } else if (action === 'toggle') {
    // Toggle
    for (let i = 0; i < classes.length; i++) {
      oldClasses = oldClasses.filter((c) => c !== classes[i].trim());
      if (cmp.elem.classList.contains(classes[i])) {
        cmp.elem.classList.remove(classes[i].trim());
        continue;
      }
      cmp.elem.classList.add(classes[i].trim());
      oldClasses.push(classes[i].trim());
    }
    setPropsValue(cmp, { class: oldClasses.join(' ').trim().split(' ') });
  } else {
    if (action === 'replace') {
      // Replace
      cmp.elem.removeAttribute('class');
      setPropsValue(cmp, { class: classes });
    } else {
      // Add
      const addedClass = `${oldClasses.join(' ').trim()} ${classes.join(' ')}`.trim();
      setPropsValue(cmp, { class: addedClass.split(' ') });
    }
    for (let i = 0; i < classes.length; i++) {
      cmp.elem.classList.add(classes[i].trim());
    }
  }

  return cmp;
};

const updateCmpAttr = (cmp: TCMP, newAttr: TAttr) => {
  const attrKeys = Object.keys(newAttr);
  for (let i = 0; i < attrKeys.length; i++) {
    const value = newAttr[attrKeys[i]];
    cmp.elem.setAttribute(attrKeys[i], String(value));
    if (cmp.props?.attr) {
      cmp.props.attr[attrKeys[i]] = String(value);
    }
  }

  return cmp;
};

const removeCmpAttr = (cmp: TCMP, attrKey: string | string[]) => {
  let attributeKeys: string | string[] = [];
  const attrProps = cmp.props?.attr;
  if (Array.isArray(attrKey)) {
    attributeKeys = attrKey;
  } else if (typeof attrKey === 'string') {
    attributeKeys.push(attrKey);
  }
  for (let i = 0; i < attributeKeys.length; i++) {
    cmp.elem.removeAttribute(attributeKeys[i]);
    if (attrProps) delete attrProps[attributeKeys[i]];
  }
  setPropsValue(cmp, { attr: attrProps });

  return cmp;
};

const updateCmpStyle = (cmp: TCMP, newStyle: TStyle) => {
  const styleProps = Object.keys(newStyle);
  for (let i = 0; i < styleProps.length; i++) {
    const prop = styleProps[i];
    const value = newStyle[styleProps[i]];
    if (prop && value !== null) {
      // @TODO: test if null values remove the rule?
      const valueAsString = String(value);
      cmp.elem.style[prop as unknown as number] = valueAsString;
      setPropsValue(cmp, { style: { ...cmp.props?.style, [prop]: valueAsString } });
    } else if (value === null) {
      cmp.elem.style.removeProperty(prop);
      cmp.elem.style[prop as unknown as number] = '';
      if (cmp.props?.style) delete cmp.props.style[prop];
    }
  }

  return cmp;
};

const updateCmpText = (cmp: TCMP, newText: string) => {
  if (!cmp.props?.text && typeof cmp.props?.text !== 'string') {
    throw new Error(
      'Cannot update text, CMP is not a text CMP. To change this to a text CMP, use the "cmp.update({ text })" function instead.'
    );
  }
  cmp.elem.textContent = newText;
  setPropsValue(cmp, { text: newText });

  return cmp;
};

const updateCmpAnim = (cmp: TCMP, animChain: TAnimChain[]) => {
  removeAnim(cmp, 'cmpAnim');

  if (!animChain?.length) {
    delete cmp.timers.cmpAnim;
    return cmp;
  }

  const animState: TAnimState = {
    setState: (key, value) => (animState.state[key] = value),
    removeState: (key) => delete animState.state[key],
    state: {},
  };

  cmp.timers.cmpAnim = { fn: null, curIndex: 0, animState };

  const timerFn = () => {
    const curIndex = cmp.timers.cmpAnim.curIndex || 0;
    const curAnim = animChain[curIndex];

    let nextIndex: null | number = null;

    // Check previous anim phaseEndFn
    const prevAnim = animChain[curIndex - 1];
    if (prevAnim?.phaseEndFn) {
      const phaseEndResult = cmp.timers.cmpAnim.animState
        ? prevAnim.phaseEndFn(cmp, cmp.timers.cmpAnim.animState)
        : null;
      nextIndex = typeof phaseEndResult === 'number' ? phaseEndResult : null;
      if (nextIndex !== null) {
        cmp.timers.cmpAnim.curIndex = nextIndex;
        timerFn();
      }
    }

    // Check if we are at the end of the chain
    if (curIndex >= animChain.length) {
      return;
    }

    // Check current anim phaseStartFn
    if (curAnim?.phaseStartFn) {
      const phaseStartResult = cmp.timers.cmpAnim.animState
        ? curAnim.phaseStartFn(cmp, cmp.timers.cmpAnim.animState)
        : null;
      nextIndex = typeof phaseStartResult === 'number' ? phaseStartResult : null;
    }

    if (curAnim.class) {
      updateCmpClass(cmp, curAnim.class, curAnim.classAction);
    }

    if (curAnim.style) {
      updateCmpStyle(cmp, curAnim.style);
    }

    cmp.timers.cmpAnim.fn = setTimeout(timerFn, curAnim.duration);

    if (curAnim.gotoIndex !== undefined) {
      cmp.timers.cmpAnim.curIndex =
        typeof curAnim.gotoIndex === 'number'
          ? curAnim.gotoIndex
          : curAnim.gotoIndex(cmp, cmp.timers.cmpAnim.animState);
      return;
    }
    cmp.timers.cmpAnim.curIndex =
      nextIndex !== null ? nextIndex : (cmp.timers.cmpAnim.curIndex || 0) + 1;
  };
  timerFn();

  return cmp;
};

const focusCmp = (cmp: TCMP, focusValueToProps?: boolean) => {
  cmp.elem.focus();
  if (cmp.elem instanceof HTMLInputElement) {
    cmp.elem.setSelectionRange(9999999999999, 9999999999999);
  }
  if (focusValueToProps !== undefined) {
    setPropsValue(cmp, { focus: focusValueToProps });
  }
  return cmp;
};

const blurCmp = (cmp: TCMP, focusValueToProps?: boolean) => {
  cmp.elem.blur();
  if (focusValueToProps !== undefined) {
    setPropsValue(cmp, { focus: focusValueToProps });
  }
  return cmp;
};

const scrollCmpIntoView = (
  cmp: TCMP,
  params?: boolean | ScrollIntoViewOptions,
  timeout?: number
) => {
  if (timeout !== undefined) {
    if (cmp.timers.scrollIntoView)
      clearTimeout(cmp.timers.scrollIntoView.fn as SetTimeout | undefined);
    const timer = setTimeout(() => {
      cmp.elem.scrollIntoView(params);
      if (cmp.timers.scrollIntoView)
        clearTimeout(cmp.timers.scrollIntoView.fn as SetTimeout | undefined);
    }, timeout);
    cmp.timers.scrollIntoView = { fn: timer };
  } else {
    cmp.elem.scrollIntoView(params);
  }
  return cmp;
};

const checkMatchingParent = (elemToCheck: HTMLElement | null, elemTarget: HTMLElement): boolean => {
  if (!elemToCheck) return false;
  if (elemToCheck === elemTarget) return true;
  return checkMatchingParent(elemToCheck.parentElement, elemTarget);
};

const onClickOutsideListener: {
  count: number;
  fns: { [key: string]: { fn: (e: Event) => void; elem: HTMLElement } };
  mainFn: (e: Event) => void;
} = {
  count: 0,
  fns: {},
  mainFn: (e: Event) => {
    const clickedElem = e.target as HTMLElement;
    const fnsKeys = Object.keys(onClickOutsideListener.fns);
    for (let i = 0; i < fnsKeys.length; i++) {
      const listener = onClickOutsideListener.fns[fnsKeys[i]];
      if (!checkMatchingParent(clickedElem, listener.elem)) listener.fn(e);
    }
  },
};

const createOutsideClickListener = (cmp: TCMP) => {
  if (!cmp.props?.onClickOutside) {
    removeOutsideClickListener(cmp);
    return;
  }
  if (onClickOutsideListener.count === 0) {
    document.removeEventListener('click', onClickOutsideListener.mainFn);
    document.addEventListener('click', onClickOutsideListener.mainFn);
  }
  const onClickOutside = cmp.props.onClickOutside;
  onClickOutsideListener.fns[cmp.id] = { fn: (e: Event) => onClickOutside(e, cmp), elem: cmp.elem };
  onClickOutsideListener.count += 1;
};

const removeOutsideClickListener = (cmp: TCMP) => {
  if (!onClickOutsideListener.fns[cmp.id]) return;
  if (onClickOutsideListener.count === 1) {
    document.removeEventListener('click', onClickOutsideListener.mainFn);
  }
  delete onClickOutsideListener.fns[cmp.id];
  onClickOutsideListener.count -= 1;
};

const runAnims = (cmp: TCMP) => {
  if (cmp.props?.anim) updateCmpAnim(cmp, cmp.props?.anim);
};

const removeAnim = (cmp: TCMP, animKey: string) => {
  clearTimeout(cmp.timers[animKey]?.fn as SetTimeout | undefined);
  delete cmp.timers[animKey];
};

const removeAnims = (cmp: TCMP) => {
  const timerKeys = Object.keys(cmp.timers);
  for (let i = 0; i < timerKeys.length; i++) {
    removeAnim(cmp, timerKeys[i]);
  }
};

const setPropsValue = (cmp: TCMP, props: Partial<TProps>) =>
  (cmp.props = { ...cmp.props, ...props });

const replaceCmpWithAnother = (oldCmp: TCMP, newCmp: TCMP) => {
  const id = oldCmp.id;

  // Props
  const attach = oldCmp.props?.attach;
  const settings = oldCmp.props?.settings;
  oldCmp.props = newCmp.props;
  if (oldCmp.props?.id) oldCmp.props.id = id;
  if (attach && oldCmp.props?.attach) oldCmp.props.attach = attach;
  if (settings && oldCmp.props?.settings) oldCmp.props.settings = settings;

  // Do not reference the parent, parentElem or the functions,
  // reference everything else.
  oldCmp.id = id;
  oldCmp.elem = newCmp.elem;
  oldCmp.children = newCmp.children;
  oldCmp.listeners = newCmp.listeners;
  oldCmp.timers = newCmp.timers;

  // Set the replaced cmp back to cache
  cmps[id] = oldCmp;
};

const stylesInHead: { [key: string]: boolean } = {};

/**
 * Adds styles to the Document head
 * @param id (string) id of the styles addition to the Document head
 * @param css (string) CSS string to be added inside the style tags
 */
export const addStylesToHead = (id: string, css: string) => {
  if (stylesInHead[id]) return;

  const headElem = document.querySelector('head');
  const styleElem = document.createElement('style');
  styleElem.textContent = css;
  if (headElem) {
    headElem.insertAdjacentElement('afterbegin', styleElem);
  } else {
    const bodyElem = document.querySelector('body');
    if (bodyElem) bodyElem.appendChild(styleElem);
  }

  stylesInHead[id] = true;
};

/**
 * Returns an array of CSS class strings
 * @param classArgs ((string | string[] | undefined | null)[]) classes to be added to the classes array
 * @returns (string[])
 */
export const classes = (...classArgs: (string | string[] | undefined | null)[]) => {
  let classes: string[] = [];
  for (let i = 0; i < classArgs.length; i++) {
    const c = classArgs[i];
    if (!c) continue;
    if (typeof c === 'string') {
      classes.push(c);
      continue;
    }
    classes = [...classes, ...c];
  }
  return classes;
};
