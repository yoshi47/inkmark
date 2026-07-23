import { describe, expect, it } from 'vitest';
import type { CommentMeta } from './types.js';
import { nextId, noteFor, noteFreeHighlight, parse } from './parse.js';

const DOC = `x {==h==}{>>note<<}{#c1} y

---
comments:
  c1:
    by: user
    at: "t"
`;

describe('parse', () => {
  it('returns body, spans and endmatter together', () => {
    const doc = parse(DOC);
    expect(doc.body.startsWith('x {==h==}')).toBe(true);
    expect(doc.spans.map((s) => s.kind)).toEqual(['highlight', 'comment']);
    const c1: CommentMeta | undefined = doc.endmatter.comments['c1'];
    expect(c1).toMatchObject({ by: 'user' });
  });

  it('nextId allocates max+1 across inline ids and endmatter', () => {
    const doc = parse(DOC);
    expect(nextId(doc, 'c')).toBe('c2');
    expect(nextId(doc, 's')).toBe('s1');
  });

  it('handles a doc with no endmatter', () => {
    const doc = parse('hello {>>q<<}');
    expect(doc.endmatter).toEqual({ comments: {}, suggestions: {} });
    expect(nextId(doc, 'c')).toBe('c1');
  });

  it('nextId handles multi-digit ids numerically (c10 > c9)', () => {
    const doc = parse('a {>>q<<}{#c9} b {>>r<<}{#c10}');
    expect(nextId(doc, 'c')).toBe('c11');
  });

  it('noteFor reads a note from the span with the id, a trailing span, or the endmatter', () => {
    expect(noteFor(parse(DOC), 'c1')).toBe('note');
    expect(noteFor(parse('x {==h==}{#c1}{>>trailing<<} y'), 'c1')).toBe('trailing');
    expect(
      noteFor(parse('x {==h==}{#c1} y\n\n---\ncomments:\n  c1:\n    body: meta\n'), 'c1'),
    ).toBe('meta');
    expect(noteFor(parse('x {==h==}{#c1} y'), 'c1')).toBeNull();
  });

  it('noteFreeHighlight only accepts a highlight span with no note anywhere', () => {
    expect(noteFreeHighlight(parse('x {==h==}{#c1} y'), 'c1')).toMatchObject({ inner: 'h' });
    expect(noteFreeHighlight(parse(DOC), 'c1')).toBeNull();
    expect(noteFreeHighlight(parse('x {==h==}{#c1}{>>trailing<<} y'), 'c1')).toBeNull();
    expect(noteFreeHighlight(parse('x {++ins++}{#s1} y'), 's1')).toBeNull();
  });

  it('nextId counts endmatter-only ids with no inline markers', () => {
    const fixture = `plain body, no markers

---
comments:
  c2:
    by: AI
    at: t
    re: c1
    body: answer
`;
    const doc = parse(fixture);
    expect(nextId(doc, 'c')).toBe('c3');
  });
});
