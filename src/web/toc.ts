import { MARKER_CHAR } from './rehypeCriticMarkup.js';

export interface TocEntry {
  /** The key the jump looks the heading up by. */
  id: string;
  /** 1–6, from the tag name. */
  level: number;
  text: string;
}

/**
 * Read the table of contents out of the rendered document rather than the markdown source.
 *
 * The label has to be the text the reader is looking at: inline emphasis, links and CriticMarkup
 * marks are all resolved by the time the heading is in the DOM, and `textContent` flattens them
 * for free. Parsing the source again would mean re-implementing every one of those, and drifting
 * from the renderer the first time one of them changed.
 */
export function collectHeadings(root: HTMLElement): TocEntry[] {
  const out: TocEntry[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    // No id, no jump target — a row that answers no click.
    if (el.id === '') continue;
    // A heading commented end to end renders as nothing but the marker, since an anchored note
    // replaces the run it covers. Stripping the marker empties the label, and a row with no text
    // is a row nobody can aim at — so such a heading is left out until the comment is removed.
    const text = el.textContent.replaceAll(MARKER_CHAR, '').trim();
    if (text === '') continue;
    const level = Number(el.tagName.slice(1));
    out.push({ id: el.id, level, text });
  }
  return out;
}

/**
 * Which entry the outline should highlight, given the ones currently in the scroll-spy zone.
 *
 * Answering from `entries` rather than from the visible set is what keeps the result something the
 * outline can actually show: a heading can be rendered and observed yet have no row here (one
 * commented end to end has no label left), and naming it would highlight nothing at all.
 *
 * An empty zone keeps `previous`, because the reader is then in the middle of a long section —
 * exactly when blanking the highlight would take away the answer they are looking for.
 */
export function pickActive(
  entries: TocEntry[],
  visible: ReadonlySet<string>,
  previous: string | null,
): string | null {
  for (const entry of entries) {
    if (visible.has(entry.id)) return entry.id;
  }
  return previous;
}
