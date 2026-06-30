import { describe, expect, it } from 'vitest';
import type { CommentMeta } from './types.js';
import { nextId, parse } from './parse.js';

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
});
