import type { Endmatter, ParsedDoc } from './types.js';
import { serializeEndmatter } from './endmatter.js';
import { hasReplies, nextId, noteFreeHighlight, parse } from './parse.js';
import { tokenize } from './tokenize.js';

const CLOSERS = ['<<}', '==}', '++}', '--}', '~~}'];

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
  wrapped: string,
  id: string,
  author: string,
  at: string,
): { md: string; id: string } {
  const newBody = doc.body.slice(0, range[0]) + wrapped + doc.body.slice(range[1]);
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
  return wrapSelection(doc, range, `{==${selected}==}{>>${commentBody}<<}{#${id}}`, id, author, at);
}

export function insertHighlight(
  md: string,
  range: [number, number],
  author: string,
  at: string,
  expectedText?: string,
): { md: string; id: string } {
  const { doc, selected, id } = prepareMark(md, range, expectedText);
  return wrapSelection(doc, range, `{==${selected}==}{#${id}}`, id, author, at);
}

/**
 * Unwrap a note-free highlight, leaving its text behind. A no-op for anything
 * else: `applySuggestion` would happily splice a comment's note text into the
 * body, so removal refuses rather than trusting the caller to have checked.
 * Threads with replies are refused too — dropping only `comments[id]` would
 * leave the replies pointing at a parent that no longer exists.
 */
export function removeHighlight(md: string, id: string): string {
  const doc = parse(md);
  const span = noteFreeHighlight(doc, id);
  if (span === null || hasReplies(doc, id)) return md;
  const newBody = doc.body.slice(0, span.start) + span.inner + doc.body.slice(span.end);
  const { [id]: _removed, ...comments } = doc.endmatter.comments;
  return rebuild(newBody, { ...doc.endmatter, comments });
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
