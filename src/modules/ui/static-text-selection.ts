const STATIC_UI_ROOTS = '.app-shell, .custom-select__listbox--portal, [data-static-ui]';
const EDITABLE_CONTROLS = 'input, textarea, select, [contenteditable="true"]';

interface SelectionSnapshot {
  anchor: Node | null;
  anchorOffset: number;
  focus: Node | null;
  focusOffset: number;
  text: string;
}

function snapshot(scope: Document | ShadowRoot): SelectionSnapshot | undefined {
  const selection =
    'host' in scope
      ? ((scope as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ??
        scope.ownerDocument.getSelection())
      : scope.getSelection();
  if (!selection || selection.isCollapsed) return undefined;
  return {
    anchor: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focus: selection.focusNode,
    focusOffset: selection.focusOffset,
    text: selection.toString(),
  };
}

function changed(before: SelectionSnapshot | undefined, after: SelectionSnapshot): boolean {
  return (
    !before ||
    Object.keys(after).some(
      (key) => before[key as keyof SelectionSnapshot] !== after[key as keyof SelectionSnapshot],
    )
  );
}

/**
 * A static label can be selected without activating its enclosing button,
 * summary or link on pointer release. This is scoped to extension-owned UI,
 * including its portal menus. It never cancels selection, copy or key events.
 */
export function installStaticTextSelectionGuard(doc: Document): () => void {
  return installSelectionGuard(doc);
}

/** Shadow UI needs its own selection and capture boundary, not the retargeted host. */
export function installShadowStaticTextSelectionGuard(root: ShadowRoot): () => void {
  return installSelectionGuard(root);
}

function installSelectionGuard(scope: Document | ShadowRoot): () => void {
  const doc = 'host' in scope ? scope.ownerDocument : scope;
  let gesture:
    | {
        root: Element | ShadowRoot;
        target: Element;
        x: number;
        y: number;
        moved: boolean;
        before: SelectionSnapshot | undefined;
      }
    | undefined;
  const reset = () => {
    gesture = undefined;
  };
  const down = (event: PointerEvent) => {
    reset();
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const root = 'host' in scope ? scope : event.target.closest(STATIC_UI_ROOTS);
    if (!root || event.target.closest(EDITABLE_CONTROLS)) return;
    gesture = {
      root,
      target: event.target,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      before: snapshot(scope),
    };
  };
  const move = (event: PointerEvent) => {
    if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3)
      gesture.moved = true;
  };
  const click = (event: MouseEvent) => {
    const current = gesture;
    reset();
    // Keyboard and assistive activation must continue to work even while text
    // is selected. An old selection must not consume the next ordinary click.
    if (!current || event.detail === 0 || !(event.target instanceof Element)) return;
    if (!current.root.contains(event.target) || event.target.closest(EDITABLE_CONTROLS)) return;
    const selection = snapshot(scope);
    if (!selection?.text) return;
    const reselectedSameLabel =
      current.moved &&
      !!selection.anchor &&
      !!selection.focus &&
      current.target.contains(selection.anchor) &&
      current.target.contains(selection.focus);
    if (!changed(current.before, selection) && !reselectedSameLabel) return;
    if (!current.moved && event.detail < 2 && !event.shiftKey) return;
    if (
      !selection.anchor ||
      !selection.focus ||
      !current.root.contains(selection.anchor) ||
      !current.root.contains(selection.focus)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  scope.addEventListener('pointerdown', down as EventListener, true);
  scope.addEventListener('pointermove', move as EventListener, true);
  scope.addEventListener('pointerup', move as EventListener, true);
  scope.addEventListener('pointercancel', reset, true);
  scope.addEventListener('click', click as EventListener, true);
  doc.defaultView?.addEventListener('blur', reset);
  return () => {
    reset();
    scope.removeEventListener('pointerdown', down as EventListener, true);
    scope.removeEventListener('pointermove', move as EventListener, true);
    scope.removeEventListener('pointerup', move as EventListener, true);
    scope.removeEventListener('pointercancel', reset, true);
    scope.removeEventListener('click', click as EventListener, true);
    doc.defaultView?.removeEventListener('blur', reset);
  };
}
