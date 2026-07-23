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

describe('resolveSelectionRange with inline code', () => {
  // body: "see `.zshrc` here" — the code run's source (with backticks) is 4..12, its text ".zshrc".
  const body = 'see `.zshrc` here';
  const html =
    '<p><span data-src-start="0" data-src-end="4">see </span>' +
    '<code><span data-src-start="4" data-src-end="12" data-src-atomic="true">.zshrc</span></code>' +
    '<span data-src-start="12" data-src-end="17"> here</span></p>';

  function runs(): { root: HTMLElement; lead: Node; code: Node; tail: Node } {
    const root = document.createElement('article');
    root.innerHTML = html;
    const lead = root.querySelector('[data-src-start="0"]')?.firstChild;
    const code = root.querySelector('[data-src-start="4"]')?.firstChild;
    const tail = root.querySelector('[data-src-start="12"]')?.firstChild;
    if (lead == null || code == null || tail == null) throw new Error('setup');
    return { root, lead, code, tail };
  }

  it('leaves a selection straight across a code run anchored on the plain runs', () => {
    const { root, lead, tail } = runs();
    expect(resolveSelectionRange(sel(root, lead, 0, tail, 5), body, root)).toEqual({
      ok: true,
      start: 0,
      end: 17,
      text: 'see `.zshrc` here',
    });
  });

  it('expands a selection inside a code run to the whole delimited run', () => {
    const { root, code } = runs();
    expect(resolveSelectionRange(sel(root, code, 1, code, 3), body, root)).toEqual({
      ok: true,
      start: 4,
      end: 12,
      text: '`.zshrc`',
    });
  });

  it('snaps only the start when a selection begins in a code run (the reported heading case)', () => {
    const { root, code, tail } = runs();
    expect(resolveSelectionRange(sel(root, code, 2, tail, 5), body, root)).toEqual({
      ok: true,
      start: 4,
      end: 17,
      text: '`.zshrc` here',
    });
  });

  it('snaps only the end when a selection ends inside a code run', () => {
    const { root, lead, code } = runs();
    expect(resolveSelectionRange(sel(root, lead, 0, code, 3), body, root)).toEqual({
      ok: true,
      start: 0,
      end: 12,
      text: 'see `.zshrc`',
    });
  });

  it('does not swallow a code run when the selection merely ends at its leading edge', () => {
    const { root, lead, code } = runs();
    expect(resolveSelectionRange(sel(root, lead, 0, code, 0), body, root)).toEqual({
      ok: true,
      start: 0,
      end: 4,
      text: 'see ',
    });
  });

  it('does not swallow a code run when the selection merely starts at its trailing edge', () => {
    const { root, code, tail } = runs();
    expect(resolveSelectionRange(sel(root, code, 6, tail, 5), body, root)).toEqual({
      ok: true,
      start: 12,
      end: 17,
      text: ' here',
    });
  });

  it('snaps both endpoints when they sit in two different code runs', () => {
    const twoRuns = 'a `b` c `d` e';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="2">a </span>' +
      '<code><span data-src-start="2" data-src-end="5" data-src-atomic="true">b</span></code>' +
      '<span data-src-start="5" data-src-end="8"> c </span>' +
      '<code><span data-src-start="8" data-src-end="11" data-src-atomic="true">d</span></code>' +
      '<span data-src-start="11" data-src-end="13"> e</span></p>';
    const first = root.querySelector('[data-src-start="2"]')?.firstChild;
    const second = root.querySelector('[data-src-start="8"]')?.firstChild;
    if (first == null || second == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, first, 0, second, 1), twoRuns, root)).toEqual({
      ok: true,
      start: 2,
      end: 11,
      text: '`b` c `d`',
    });
  });

  it('keeps both endpoints put when each sits at a non-swallowing run edge', () => {
    const twoRuns = 'a `b` c `d` e';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="2">a </span>' +
      '<code><span data-src-start="2" data-src-end="5" data-src-atomic="true">b</span></code>' +
      '<span data-src-start="5" data-src-end="8"> c </span>' +
      '<code><span data-src-start="8" data-src-end="11" data-src-atomic="true">d</span></code>' +
      '<span data-src-start="11" data-src-end="13"> e</span></p>';
    const first = root.querySelector('[data-src-start="2"]')?.firstChild;
    const second = root.querySelector('[data-src-start="8"]')?.firstChild;
    if (first == null || second == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, first, 1, second, 0), twoRuns, root)).toEqual({
      ok: true,
      start: 5,
      end: 8,
      text: ' c ',
    });
  });

  it('keeps the delimiters of a space-padded code run', () => {
    const padded = 'see ` a ` here';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><code><span data-src-start="4" data-src-end="9" data-src-atomic="true">a</span></code></p>';
    const code = root.querySelector('[data-src-start="4"]')?.firstChild;
    if (code == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, code, 0, code, 1), padded, root)).toEqual({
      ok: true,
      start: 4,
      end: 9,
      text: '` a `',
    });
  });

  it('keeps the delimiters of a code run quoting a backtick', () => {
    const nested = 'see ``a`b`` here';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><code><span data-src-start="4" data-src-end="11" data-src-atomic="true">a`b</span></code></p>';
    const code = root.querySelector('[data-src-start="4"]')?.firstChild;
    if (code == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, code, 0, code, 3), nested, root)).toEqual({
      ok: true,
      start: 4,
      end: 11,
      text: '``a`b``',
    });
  });

  it('refuses a code run overlapping an existing mark', () => {
    const marked = 'x {==`m`==} y';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="2">x </span>' +
      '<mark data-cm-kind="highlight">' +
      '<code><span data-src-start="5" data-src-end="8" data-src-atomic="true">m</span></code>' +
      '</mark><span data-src-start="11" data-src-end="13"> y</span></p>';
    const code = root.querySelector('[data-src-start="5"]')?.firstChild;
    if (code == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, code, 0, code, 1), marked, root)).toEqual({
      ok: false,
      reason: 'overlaps-mark',
    });
  });

  it('refuses a code run whose text the source cannot account for character by character', () => {
    // A code span broken across lines: CommonMark folds the newline to a space when rendering,
    // so the run's characters no longer line up with its source and snapping could mis-anchor.
    const folded = 'see `a\nb` here';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><code><span data-src-start="4" data-src-end="9" data-src-atomic="true">a b</span></code></p>';
    const code = root.querySelector('[data-src-start="4"]')?.firstChild;
    if (code == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, code, 0, code, 3), folded, root)).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
  });

  it('still refuses an unflagged run whose source differs from its text', () => {
    // A list continuation line: the source keeps the indentation the renderer dropped.
    const indented = '- a\n  b';
    const root = document.createElement('article');
    root.innerHTML = '<ul><li><span data-src-start="2" data-src-end="7">a\nb</span></li></ul>';
    const n = root.querySelector('[data-src-start="2"]')?.firstChild;
    if (n == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, n, 0, n, 3), indented, root)).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
  });
});
