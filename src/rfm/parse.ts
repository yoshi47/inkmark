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
 */
export function noteFor(doc: ParsedDoc, id: string): string | null {
  const i = doc.spans.findIndex((s) => s.id === id);
  const own = doc.spans[i];
  if (own?.kind === 'comment') return own.inner;
  const next = doc.spans[i + 1];
  if (own !== undefined && next?.kind === 'comment' && next.id === undefined) return next.inner;
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

export function hasReplies(doc: ParsedDoc, id: string): boolean {
  return Object.values(doc.endmatter.comments).some((c) => c.re === id);
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
