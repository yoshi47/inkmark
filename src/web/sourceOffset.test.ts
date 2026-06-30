import { describe, expect, it } from 'vitest';
import { resolveSelectionRange } from './sourceOffset.js';

function selectWithin(el: Node, start: number, end: number): Selection {
  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  const range = document.createRange();
  const fc = el.firstChild;
  if (fc === null) throw new Error('no firstChild');
  range.setStart(fc, start);
  range.setEnd(fc, end);
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe('resolveSelectionRange', () => {
  it('maps a selection inside one source span to body offsets', () => {
    document.body.innerHTML =
      '<p><span data-src-start="0" data-src-end="11">Hello world</span></p>';
    const span = document.querySelector('span');
    if (span === null) throw new Error('no span');
    const sel = selectWithin(span, 6, 11); // "world"
    const body = 'Hello world\n';
    expect(resolveSelectionRange(sel, body)).toEqual({ start: 6, end: 11 });
  });

  it('returns null when the slice does not round-trip (verification guard)', () => {
    document.body.innerHTML = '<p><span data-src-start="0" data-src-end="3">abc</span></p>';
    const span = document.querySelector('span');
    if (span === null) throw new Error('no span');
    const sel = selectWithin(span, 0, 3);
    const body = 'XYZdifferent\n'; // body[0,3) !== "abc"
    expect(resolveSelectionRange(sel, body)).toBeNull();
  });

  it('returns null when selection spans two source spans', () => {
    document.body.innerHTML =
      '<p><span data-src-start="0" data-src-end="2">ab</span>' +
      '<span data-src-start="2" data-src-end="4">cd</span></p>';
    const spans = document.querySelectorAll('span');
    const sel = window.getSelection();
    if (sel === null) throw new Error('no selection');
    const range = document.createRange();
    const span0 = spans[0];
    if (span0 === undefined) throw new Error('no span0');
    const fc0 = span0.firstChild;
    if (fc0 === null) throw new Error('no firstChild0');
    const span1 = spans[1];
    if (span1 === undefined) throw new Error('no span1');
    const fc1 = span1.firstChild;
    if (fc1 === null) throw new Error('no firstChild1');
    range.setStart(fc0, 0);
    range.setEnd(fc1, 2);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(resolveSelectionRange(sel, 'abcd\n')).toBeNull();
  });
});
