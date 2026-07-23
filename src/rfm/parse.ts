import type { ParsedDoc, Span } from './types.js';
import { parseEndmatter, splitEndmatter } from './endmatter.js';
import { tokenize } from './tokenize.js';

export function parse(md: string): ParsedDoc {
  const { body, endmatterRaw } = splitEndmatter(md);
  const spans = tokenize(body);
  const endmatter = parseEndmatter(endmatterRaw);
  return { body, endmatterRaw, spans, endmatter };
}

/**
 * The note attached to a mark, from any of the three places one can sit: the
 * {>> <<} span carrying the id, a span written right after it
 * (`{==x==}{#c1}{>>note<<}` — an agent may well write that, since CriticMarkup
 * itself has no id concept), or the endmatter entry's own body.
 *
 * The trailing span has to touch the mark. Claiming a note sentences away would
 * make it the thread's to delete, and an agent's unrelated note would go down
 * with a mark it never belonged to.
 */
export function noteFor(doc: ParsedDoc, id: string): string | null {
  const i = doc.spans.findIndex((s) => s.id === id);
  const own = doc.spans[i];
  if (own?.kind === 'comment') return own.inner;
  const next = doc.spans[i + 1];
  if (
    own !== undefined &&
    next?.kind === 'comment' &&
    next.id === undefined &&
    next.start === own.end
  ) {
    return next.inner;
  }
  return doc.endmatter.comments[id]?.body ?? null;
}

/**
 * The span of a mark that says nothing. Asking for the note rather than for the
 * absence of a comment span keeps the trailing and endmatter shapes above from
 * reading as note-free, which would let the UI offer to delete text nobody
 * meant to lose.
 */
export function noteFreeHighlight(doc: ParsedDoc, id: string): Span | null {
  const span = doc.spans.find((s) => s.id === id);
  if (span?.kind !== 'highlight') return null;
  return noteFor(doc, id) === null ? span : null;
}

/**
 * A thread id together with every reply hanging off it, however deep. Removal
 * and the confirmation that precedes it both read from here, so the count the
 * user agrees to cannot drift from what actually goes.
 */
export function threadIds(doc: ParsedDoc, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, meta] of Object.entries(doc.endmatter.comments)) {
      if (meta.re !== undefined && ids.has(meta.re) && !ids.has(id)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return ids;
}

export function nextId(doc: ParsedDoc, prefix: 'c' | 's'): string {
  const seen = new Set<string>();
  for (const s of doc.spans) {
    if (s.id !== undefined) {
      seen.add(s.id);
    }
  }
  for (const id of Object.keys(doc.endmatter.comments)) {
    seen.add(id);
  }
  for (const id of Object.keys(doc.endmatter.suggestions)) {
    seen.add(id);
  }
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of seen) {
    const m = re.exec(id);
    if (m !== null) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}${String(max + 1)}`;
}
