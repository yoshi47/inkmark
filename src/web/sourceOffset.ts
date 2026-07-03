import { tokenize } from '../rfm/tokenize.js';
import { sameBlock } from './blockOffsets.js';

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

function textFromContentStart(el: HTMLElement, container: Node, offset: number): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(container, offset);
  return r.toString();
}

function textToContentEnd(el: HTMLElement, container: Node, offset: number): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setStart(container, offset);
  return r.toString();
}

export type SelectionResult =
  | { ok: true; start: number; end: number; text: string }
  | { ok: false; reason: 'cross-block' | 'overlaps-mark' | 'unresolvable' };

export function resolveSelectionRange(
  sel: Selection,
  body: string,
  root: HTMLElement,
): SelectionResult | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = annotatedAncestor(range.startContainer);
  const endEl = annotatedAncestor(range.endContainer);
  if (startEl === null || endEl === null) return null;

  if (!sameBlock(range.startContainer, range.endContainer, root)) {
    return { ok: false, reason: 'cross-block' };
  }

  const sBase = startEl.dataset['srcStart'];
  const sEndAttr = startEl.dataset['srcEnd'];
  const eBase = endEl.dataset['srcStart'];
  if (sBase === undefined || sEndAttr === undefined || eBase === undefined) {
    return { ok: false, reason: 'unresolvable' };
  }

  const startHead = textFromContentStart(startEl, range.startContainer, range.startOffset);
  const endHead = textFromContentStart(endEl, range.endContainer, range.endOffset);
  const start = Number(sBase) + startHead.length;
  const end = Number(eBase) + endHead.length;
  if (!(start < end) || end > body.length) return { ok: false, reason: 'unresolvable' };

  // Endpoint verification by STRING equality (each run is plain text ⇒ source == rendered
  // within a run). This is the guard against silent mis-anchoring, so compare content, not
  // just length: the source from the computed start to the run's source-end must equal the
  // DOM text from the selection start to the run's end; symmetrically for the end run.
  const startTail = textToContentEnd(startEl, range.startContainer, range.startOffset);
  if (body.slice(start, Number(sEndAttr)) !== startTail)
    return { ok: false, reason: 'unresolvable' };
  if (body.slice(Number(eBase), end) !== endHead) return { ok: false, reason: 'unresolvable' };

  for (const span of tokenize(body)) {
    if (start < span.end && span.start < end) return { ok: false, reason: 'overlaps-mark' };
  }
  return { ok: true, start, end, text: body.slice(start, end) };
}
