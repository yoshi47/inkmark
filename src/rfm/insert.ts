import type { Endmatter, ParsedDoc, Span } from './types.js';
import { serializeEndmatter } from './endmatter.js';
import { isFencedBlock } from './fence.js';
import { nextId, noteFor, noteFreeHighlight, parse, threadIds } from './parse.js';
import { tokenize } from './tokenize.js';

const CLOSERS = ['<<}', '==}', '++}', '--}', '~~}'];

/**
 * The text a mark leaves behind, giving back the newlines a block wrap needed.
 *
 * Only the ones this module wrote: the mark has to sit on whole lines of its own AND hold a fenced
 * block, the pair `wrapSelection` produces. An agent may write `{==` and `==}` on their own lines
 * around anything at all, and taking newlines back out of that would be editing prose the author
 * put there.
 */
function unwrapped(body: string, start: number, end: number, inner: string): string {
  const wholeLines =
    (start === 0 || body[start - 1] === '\n') && (end === body.length || body[end] === '\n');
  if (!wholeLines || !inner.startsWith('\n') || !inner.endsWith('\n')) return inner;
  const mid = inner.slice(1, -1);
  return isFencedBlock(mid, 0, mid.length) ? mid : inner;
}

function assertSafe(text: string, label: string): void {
  for (const c of CLOSERS) {
    if (text.includes(c)) throw new Error(`${label} may not contain "${c}"`);
  }
}

function rebuild(body: string, endmatter: Endmatter): string {
  const trimmedBody = body.replace(/\n+$/, '\n');
  const serialized = serializeEndmatter(endmatter);
  return serialized.length > 0 ? `${trimmedBody}\n---\n${serialized}` : trimmedBody;
}

function prepareMark(
  md: string,
  range: [number, number],
  expectedText: string | undefined,
): { doc: ParsedDoc; selected: string; id: string } {
  const doc = parse(md);
  const [start, end] = range;
  if (start >= end) throw new Error('empty selection');
  const selected = doc.body.slice(start, end);
  if (expectedText !== undefined && selected !== expectedText) {
    throw new Error('selection moved');
  }
  for (const span of tokenize(doc.body)) {
    if (start < span.end && span.start < end) {
      throw new Error('selection overlaps an existing mark');
    }
  }
  assertSafe(selected, 'selection');
  return { doc, selected, id: nextId(doc, 'c') };
}

function wrapSelection(
  doc: ParsedDoc,
  range: [number, number],
  selected: string,
  note: string,
  id: string,
  author: string,
  at: string,
): { md: string; id: string } {
  const [start, end] = range;
  const highlight = isFencedBlock(doc.body, start, end)
    ? `{==\n${selected}\n==}`
    : `{==${selected}==}`;
  const newBody = doc.body.slice(0, start) + highlight + note + `{#${id}}` + doc.body.slice(end);
  doc.endmatter.comments[id] = { by: author, at, resolved: false };
  return { md: rebuild(newBody, doc.endmatter), id };
}

export function insertComment(
  md: string,
  range: [number, number],
  commentBody: string,
  author: string,
  at: string,
  expectedText?: string,
): { md: string; id: string } {
  const { doc, selected, id } = prepareMark(md, range, expectedText);
  assertSafe(commentBody, 'comment');
  return wrapSelection(doc, range, selected, `{>>${commentBody}<<}`, id, author, at);
}

export function insertHighlight(
  md: string,
  range: [number, number],
  author: string,
  at: string,
  expectedText?: string,
): { md: string; id: string } {
  const { doc, selected, id } = prepareMark(md, range, expectedText);
  return wrapSelection(doc, range, selected, '', id, author, at);
}

interface Cut {
  start: number; // offset in body, inclusive
  end: number; // offset in body, exclusive
  keep: string; // text left in the mark's place
}

/** Where each mark of the thread sits, and what survives it. */
function cutsFor(doc: ParsedDoc, ids: Set<string>): Cut[] {
  const cuts: Cut[] = [];
  for (const [i, span] of doc.spans.entries()) {
    if (span.id === undefined || !ids.has(span.id)) continue;
    if (span.kind === 'highlight') {
      // Reach exactly as far as noteFor does — no further, or a note that only
      // happens to sit downstream goes down with a mark it never belonged to.
      const next: Span | undefined = doc.spans[i + 1];
      const note =
        next?.kind === 'comment' && next.id === undefined && next.start === span.end
          ? next
          : undefined;
      cuts.push({
        start: span.start,
        end: span.end,
        // The note is what the line ends with when there is one, so the whole-line test has to
        // see past it — otherwise a block mark carrying a note never gives its newlines back.
        keep: unwrapped(doc.body, span.start, note?.end ?? span.end, span.inner),
      });
      if (note !== undefined) {
        cuts.push({ start: note.start, end: note.end, keep: '' });
      }
    } else if (span.kind === 'comment') {
      // The adjacency noteFor goes without: it never pairs a note with the mark
      // in front of it, so that pairing is a guess of ours, and a highlight
      // already carrying an id is somebody else's mark.
      const prev: Span | undefined = doc.spans[i - 1];
      if (prev?.kind === 'highlight' && prev.id === undefined && prev.end === span.start) {
        cuts.push({
          start: prev.start,
          end: span.end,
          keep: unwrapped(doc.body, prev.start, span.end, prev.inner),
        });
      } else {
        cuts.push({ start: span.start, end: span.end, keep: '' });
      }
    }
  }
  return cuts;
}

function removeThread(doc: ParsedDoc, id: string): string {
  const ids = threadIds(doc, id);
  let body = doc.body;
  for (const cut of cutsFor(doc, ids).sort((a, b) => b.start - a.start)) {
    body = body.slice(0, cut.start) + cut.keep + body.slice(cut.end);
  }
  const comments = Object.fromEntries(
    Object.entries(doc.endmatter.comments).filter(([cid]) => !ids.has(cid)),
  );
  return rebuild(body, { ...doc.endmatter, comments });
}

/**
 * Unwrap a note-free highlight, leaving its text behind. A no-op for anything
 * else: `applySuggestion` would happily splice a comment's note text into the
 * body, so removal refuses rather than trusting the caller to have checked.
 * Replies come down with the thread — dropping only `comments[id]` would leave
 * them pointing at a parent that no longer exists.
 */
export function removeHighlight(md: string, id: string): string {
  const doc = parse(md);
  if (noteFreeHighlight(doc, id) === null) return md;
  return removeThread(doc, id);
}

/**
 * Delete a commented thread: the mark and its note leave the body, the text
 * they wrapped stays, and the entry and its replies leave the endmatter. Notes
 * sit in any of three places (see `noteFor`), so the span carrying the id is
 * rarely the whole of what has to go. A no-op for a note-free highlight, which
 * is `removeHighlight`'s to take.
 */
export function removeComment(md: string, id: string): string {
  const doc = parse(md);
  const span = doc.spans.find((s) => s.id === id);
  if (span === undefined) {
    // An entry outliving its mark — but only if the mark is really gone: the
    // tokenizer also yields nothing for a mark inside a fenced code block, and
    // sweeping the entry there would leave markup no id could reach again.
    // Replies are left alone; an endmatter-only one is not this call's to take.
    const meta = doc.endmatter.comments[id];
    if (meta === undefined || meta.re !== undefined) return md;
    if (doc.body.includes(`{#${id}}`)) return md;
    return removeThread(doc, id);
  }
  if (span.kind !== 'comment' && span.kind !== 'highlight') return md;
  if (noteFor(doc, id) === null) return md;
  return removeThread(doc, id);
}

export function addReply(
  md: string,
  parentId: string,
  replyBody: string,
  author: string,
  at: string,
): { md: string; id: string } {
  assertSafe(replyBody, 'reply');
  const doc = parse(md);
  const id = nextId(doc, 'c');
  doc.endmatter.comments[id] = { by: author, at, re: parentId, body: replyBody };
  return { md: rebuild(doc.body, doc.endmatter), id };
}

export function setResolved(md: string, id: string, resolved: boolean): string {
  const doc = parse(md);
  const c = doc.endmatter.comments[id];
  if (c !== undefined) {
    c.resolved = resolved;
  }
  return rebuild(doc.body, doc.endmatter);
}
