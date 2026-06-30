function annotatedAncestor(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null;
  if (node instanceof HTMLElement) {
    el = node;
  } else if (node !== null) {
    el = node.parentElement;
  } else {
    el = null;
  }
  while (el !== null && el.dataset['srcStart'] === undefined) {
    el = el.parentElement;
  }
  return el;
}

export function resolveSelectionRange(
  sel: Selection,
  body: string,
): { end: number; start: number } | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = annotatedAncestor(range.startContainer);
  const endEl = annotatedAncestor(range.endContainer);
  if (startEl === null || endEl === null || startEl !== endEl) return null; // v1: one source run only

  const srcStart = startEl.dataset['srcStart'];
  if (srcStart === undefined) return null;
  const base = Number(srcStart);
  const pre = document.createRange();
  pre.selectNodeContents(startEl);
  pre.setEnd(range.startContainer, range.startOffset);
  const startText = pre.toString().length;
  const len = range.toString().length;
  const start = base + startText;
  const end = start + len;

  // Verification: the computed source slice must equal the selected text.
  if (body.slice(start, end) !== sel.toString()) return null;
  return { end, start };
}
