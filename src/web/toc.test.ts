import { describe, expect, it } from 'vitest';
import { collectHeadings, pickActive, type TocEntry } from './toc.js';

function root(html: string): HTMLElement {
  const el = document.createElement('article');
  el.innerHTML = html;
  return el;
}

describe('collectHeadings', () => {
  it('returns headings in document order with their level', () => {
    expect(
      collectHeadings(root('<h1 id="h-0">A</h1><p>x</p><h3 id="h-9">B</h3><h2 id="h-20">C</h2>')),
    ).toEqual([
      { id: 'h-0', level: 1, text: 'A' },
      { id: 'h-9', level: 3, text: 'B' },
      { id: 'h-20', level: 2, text: 'C' },
    ]);
  });

  it('flattens inline markup into the label', () => {
    const entries = collectHeadings(root('<h2 id="h-0">Use <code>pnpm</code> <em>now</em></h2>'));
    expect(entries[0]?.text).toBe('Use pnpm now');
  });

  it('flattens a mark into the label and drops the note marker', () => {
    // The shape rehypeCriticMarkup renders for a commented heading: the text stays, the 💬 that
    // stands in for the note belongs to the body, not to a TOC row.
    const entries = collectHeadings(
      root('<h2 id="h-0"><mark data-cm-kind="highlight">Install</mark>💬 steps</h2>'),
    );
    expect(entries[0]?.text).toBe('Install steps');
  });

  it('skips a heading with no id', () => {
    expect(collectHeadings(root('<h1>A</h1><h2 id="h-4">B</h2>'))).toEqual([
      { id: 'h-4', level: 2, text: 'B' },
    ]);
  });

  it('skips a heading whose label is empty once the marker is removed', () => {
    expect(collectHeadings(root('<h2 id="h-0">💬</h2>'))).toEqual([]);
  });

  it('returns nothing for a document with no headings', () => {
    expect(collectHeadings(root('<p>just text</p>'))).toEqual([]);
  });
});

describe('pickActive', () => {
  const entries: TocEntry[] = [
    { id: 'h-0', level: 1, text: 'A' },
    { id: 'h-10', level: 2, text: 'B' },
    { id: 'h-20', level: 2, text: 'C' },
  ];

  it('picks the first entry in document order, not the first to become visible', () => {
    // The observer reports in whatever order it likes; the reader is under the topmost one.
    expect(pickActive(entries, new Set(['h-20', 'h-10']), null)).toBe('h-10');
  });

  it('keeps the previous entry when nothing is in the zone', () => {
    // Mid-section, between two headings — the moment the highlight matters most.
    expect(pickActive(entries, new Set(), 'h-10')).toBe('h-10');
  });

  it('returns null when nothing is in the zone and nothing was active', () => {
    expect(pickActive(entries, new Set(), null)).toBeNull();
  });

  it('ignores a visible heading the outline does not list', () => {
    // A heading commented end to end is rendered but has no row. Naming it would highlight
    // nothing, blanking the outline exactly where a real answer exists.
    expect(pickActive(entries, new Set(['h-5']), 'h-0')).toBe('h-0');
  });

  it('has nothing to pick from an empty outline', () => {
    expect(pickActive([], new Set(['h-0']), null)).toBeNull();
  });
});
