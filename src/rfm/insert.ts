import type { Endmatter } from './types.js';
import { serializeEndmatter } from './endmatter.js';
import { nextId, parse } from './parse.js';

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

export function insertComment(
  md: string,
  range: [number, number],
  commentBody: string,
  author: string,
  at: string,
): { md: string; id: string } {
  const doc = parse(md);
  const [start, end] = range;
  const selected = doc.body.slice(start, end);
  assertSafe(selected, 'selection');
  assertSafe(commentBody, 'comment');
  const id = nextId(doc, 'c');
  const wrapped = `{==${selected}==}{>>${commentBody}<<}{#${id}}`;
  const newBody = doc.body.slice(0, start) + wrapped + doc.body.slice(end);
  doc.endmatter.comments[id] = { by: author, at, resolved: false };
  return { md: rebuild(newBody, doc.endmatter), id };
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
