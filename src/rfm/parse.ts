import type { ParsedDoc, Span } from './types.js';
import { parseEndmatter, splitEndmatter } from './endmatter.js';
import { tokenize } from './tokenize.js';

/**
 * Everything downstream — the fence regexes, the body slices offsets index into, the
 * spans, the selection endpoints the web app resolves — is written against LF. So the
 * conversion happens here and nowhere else, and `rebuild` puts back what `eol` remembers.
 *
 * The FIRST line ending decides, not "does a CRLF appear anywhere". inkmark documents are
 * edited by agents writing LF straight into a file a human saved as CRLF, so mixed endings
 * are the normal case rather than the corrupt one; going by any occurrence would flip a
 * whole LF file to CRLF over one appended line. The rule cuts both ways — an agent that
 * rewrites the first line flips the whole file the other way — which is why `mixedEol`
 * counts what a save would change instead of leaving the caller to find out from a diff.
 *
 * Every CR goes, `\r\n` and lone `\r` alike. Leaving lone CRs in would put a third kind of
 * line ending in `body` while claiming there are two, and the tokenizer's fence regexes
 * would stop recognising a closing fence that carries one. CommonMark treats a bare CR as
 * a line ending too, so this agrees with how the document renders.
 */
export function parse(md: string): ParsedDoc {
  const endings = md.match(/\r\n|\n|\r/g) ?? [];
  const eol = endings[0] === '\r\n' ? '\r\n' : '\n';
  const { body, endmatterRaws, unreadable } = splitEndmatter(md.replace(/\r\n?/g, '\n'));
  const spans = tokenize(body);
  const endmatter = parseEndmatter(endmatterRaws);
  return {
    body,
    spans,
    endmatter,
    unreadable,
    eol,
    mixedEol: endings.filter((e) => e !== eol).length,
  };
}

export function noteFor(doc: ParsedDoc, id: string): string | null {
  return noteSpan(doc, id)?.inner ?? doc.endmatter.comments[id]?.body ?? null;
}

/**
 * Which of the two body shapes above holds the note, or null when nothing in the
 * body does. Rewriting a note has to know: one shape's span takes in the mark's
 * own `{#id}` and the other's does not.
 */
export function noteSpan(doc: ParsedDoc, id: string): Span | null {
  const i = doc.spans.findIndex((s) => s.id === id);
  const own = doc.spans[i];
  if (own?.kind === 'comment') return own;
  const next = doc.spans[i + 1];
  if (
    own !== undefined &&
    next?.kind === 'comment' &&
    next.id === undefined &&
    next.start === own.end
  ) {
    return next;
  }
  return null;
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
  // The body itself, not just the spans: a mark inside a fence is skipped by the tokenizer,
  // so its id looks free while it is very much in the file. The same raw string check
  // `removeComment` makes (src/rfm/insert.ts) before it sweeps a mark.
  for (const m of doc.body.matchAll(/\{#([cs]\d+)\}/g)) {
    const id = m[1];
    if (id !== undefined) seen.add(id);
  }
  // An endmatter block that would not parse stays in the body as prose, and its ids are
  // YAML keys, not `{#id}` marks — a reply has no mark at all. Scanned only when there is
  // such a block: `key:` at the head of a line is ordinary enough in prose that reserving
  // it unconditionally would burn ids on any document with a definition list.
  if (doc.unreadable !== null) {
    for (const m of doc.body.matchAll(/^[ \t]*([cs]\d+):/gm)) {
      const id = m[1];
      if (id !== undefined) seen.add(id);
    }
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
