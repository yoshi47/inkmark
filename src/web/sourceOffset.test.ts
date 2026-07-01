import { afterEach, describe, expect, it } from 'vitest';
import { resolveSelectionRange } from './sourceOffset.js';

function sel(root: HTMLElement, startNode: Node, so: number, endNode: Node, eo: number): Selection {
  // jsdom's Selection only tracks ranges whose nodes are connected to the document.
  if (!root.isConnected) document.body.appendChild(root);
  const s = window.getSelection();
  if (s === null) throw new Error('no selection');
  s.removeAllRanges();
  const r = document.createRange();
  r.setStart(startNode, so);
  r.setEnd(endNode, eo);
  s.addRange(r);
  return s;
}

// Clean up appended roots between tests.
afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('resolveSelectionRange', () => {
  it('maps a selection spanning two runs across a <strong> (the reported bug)', () => {
    // body: "foo bar baz"  rendered as: <span 0-4>foo </span><strong><span 4-7>bar</span></strong><span 7-11> baz</span>
    const body = 'foo bar baz';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="4">foo </span>' +
      '<strong><span data-src-start="4" data-src-end="7">bar</span></strong>' +
      '<span data-src-start="7" data-src-end="11"> baz</span></p>';
    const first = root.querySelector('[data-src-start="0"]');
    const last = root.querySelector('[data-src-start="7"]');
    if (first?.firstChild == null || last?.firstChild == null) throw new Error('setup');
    const s = sel(root, first.firstChild, 0, last.firstChild, 4); // "foo bar baz"
    const res = resolveSelectionRange(s, body, root);
    expect(res).toEqual({ ok: true, start: 0, end: 11, text: 'foo bar baz' });
  });

  it('refuses a cross-block selection', () => {
    const body = 'a\n\nb';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="1">a</span></p>' +
      '<p><span data-src-start="3" data-src-end="4">b</span></p>';
    const a = root.querySelector('[data-src-start="0"]');
    const b = root.querySelector('[data-src-start="3"]');
    if (a?.firstChild == null || b?.firstChild == null) throw new Error('setup');
    const res = resolveSelectionRange(sel(root, a.firstChild, 0, b.firstChild, 1), body, root);
    expect(res).toEqual({ ok: false, reason: 'cross-block' });
  });

  it('refuses a selection overlapping an existing mark', () => {
    const body = 'x {==m==} y';
    const root = document.createElement('article');
    // rendered run covering "x " and then the mark; select into "x <mark>"
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="2">x </span>' +
      '<mark data-cm-kind="highlight"><span data-src-start="5" data-src-end="6">m</span></mark>' +
      '<span data-src-start="9" data-src-end="11"> y</span></p>';
    const x = root.querySelector('[data-src-start="0"]');
    const m = root.querySelector('[data-src-start="5"]');
    if (x?.firstChild == null || m?.firstChild == null) throw new Error('setup');
    const res = resolveSelectionRange(sel(root, x.firstChild, 0, m.firstChild, 1), body, root);
    expect(res).toEqual({ ok: false, reason: 'overlaps-mark' });
  });

  it('returns null for a collapsed selection', () => {
    const body = 'abc';
    const root = document.createElement('article');
    root.innerHTML = '<p><span data-src-start="0" data-src-end="3">abc</span></p>';
    const n = root.querySelector('[data-src-start="0"]');
    if (n?.firstChild == null) throw new Error('setup');
    expect(
      resolveSelectionRange(sel(root, n.firstChild, 1, n.firstChild, 1), body, root),
    ).toBeNull();
  });
});
