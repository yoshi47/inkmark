import type { Span } from '../rfm/types.js';

/** A placeholder nothing renders as markup and no author types. Private-use by design. */
const MASK = '\uE000';
const OPENER = 3;

/**
 * Hides a substitution's `~~` from the Markdown parser.
 *
 * Without this, GFM reads `{~~old~>new~~}` as `{` + a strike-through + `}`: it builds a <del> of
 * its own around the inner text, whose children then no longer line up with the source offsets the
 * mark is cut by. The split at `~>` cannot land, and the reader gets `{~old~>new~}` — the raw
 * delimiters, half eaten. Swapping only those four tildes for a placeholder keeps every offset
 * exactly where it was, and all four sit inside delimiter ranges the renderer drops when it builds
 * the mark.
 *
 * A substitution inside a fence is not in `spans` (the tokenizer skips code), so its delimiters are
 * the author's literal text and stay as typed.
 */
export function maskSubstitutions(source: string, spans: Span[]): string {
  const at: number[] = [];
  for (const s of spans) {
    if (s.kind !== 'substitution') continue;
    const innerStart = s.start + OPENER;
    at.push(s.start + 1, s.start + 2, innerStart + s.inner.length, innerStart + s.inner.length + 1);
  }
  if (at.length === 0) return source;
  let out = '';
  let prev = 0;
  for (const i of at.sort((a, b) => a - b)) {
    // A span whose start or inner text was rewritten since it was tokenized would otherwise land
    // the placeholder in the author's words; the shape of the delimiter is worth confirming.
    if (source[i] !== '~') continue;
    out += source.slice(prev, i) + MASK;
    prev = i + 1;
  }
  return out + source.slice(prev);
}
