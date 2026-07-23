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

const INLINE_CODE = /^(`+)([\s\S]*)\1$/;

/**
 * True when the run's source is its rendered text wrapped in inline-code delimiters — the only
 * shape whose endpoints may be snapped outward. The delimiter shape is re-derived from the body
 * rather than trusted from the marker attribute, so a run we cannot account for character by
 * character (e.g. CommonMark's newline-to-space folding) stays unresolvable instead of anchoring
 * somewhere wrong.
 */
function atomicRun(el: HTMLElement, body: string): boolean {
  const s = el.dataset['srcStart'];
  const e = el.dataset['srcEnd'];
  // Presence, not truthiness: the attribute serializes as "" (rehype-stringify) or "true" (React).
  if (el.dataset['srcAtomic'] === undefined || s === undefined || e === undefined) return false;
  const m = INLINE_CODE.exec(body.slice(Number(s), Number(e)));
  if (m === null) return false;
  const inner = m[2] ?? '';
  const text = el.textContent;
  return inner === text || inner === ` ${text} `; // CommonMark strips one space on each side
}

/**
 * An atomic run has no usable interior offsets, so an endpoint inside one moves out to the run's
 * source boundary. Which boundary is chosen by what the user actually selected: an endpoint sitting
 * AT a run edge (where browsers park a drag that stops next to a code span) selected none of the
 * run, so it must not swallow it — only a genuinely interior endpoint widens the range.
 */
function snapStart(head: string, runText: string, srcStart: string, srcEnd: string): number {
  return Number(head === runText ? srcEnd : srcStart);
}

function snapEnd(head: string, srcStart: string, srcEnd: string): number {
  return Number(head === '' ? srcStart : srcEnd);
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
  const eEndAttr = endEl.dataset['srcEnd'];
  if (
    sBase === undefined ||
    sEndAttr === undefined ||
    eBase === undefined ||
    eEndAttr === undefined
  ) {
    return { ok: false, reason: 'unresolvable' };
  }

  const startHead = textFromContentStart(startEl, range.startContainer, range.startOffset);
  const endHead = textFromContentStart(endEl, range.endContainer, range.endOffset);
  const startAtomic = atomicRun(startEl, body);
  const endAtomic = atomicRun(endEl, body);
  const start = startAtomic
    ? snapStart(startHead, startEl.textContent, sBase, sEndAttr)
    : Number(sBase) + startHead.length;
  const end = endAtomic ? snapEnd(endHead, eBase, eEndAttr) : Number(eBase) + endHead.length;
  if (!(start < end) || end > body.length) return { ok: false, reason: 'unresolvable' };

  // Endpoint verification by STRING equality (a non-atomic run is plain text ⇒ source == rendered
  // within it). This is the guard against silent mis-anchoring, so compare content, not just
  // length: the source from the computed start to the run's source-end must equal the DOM text
  // from the selection start to the run's end; symmetrically for the end run. Atomic runs are
  // exempt — their source never equals their text, and atomicRun already accounted for it.
  const startTail = textToContentEnd(startEl, range.startContainer, range.startOffset);
  if (!startAtomic && body.slice(start, Number(sEndAttr)) !== startTail)
    return { ok: false, reason: 'unresolvable' };
  if (!endAtomic && body.slice(Number(eBase), end) !== endHead)
    return { ok: false, reason: 'unresolvable' };

  for (const span of tokenize(body)) {
    if (start < span.end && span.start < end) return { ok: false, reason: 'overlaps-mark' };
  }
  return { ok: true, start, end, text: body.slice(start, end) };
}
