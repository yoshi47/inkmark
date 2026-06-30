import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize.js';

describe('tokenize', () => {
  it('finds a highlight+comment pair with an id', () => {
    const body = 'a {==x==}{>>note<<}{#c1} b';
    const spans = tokenize(body);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ kind: 'highlight', inner: 'x' });
    // start=9, end=24 → body.slice(9,24) === '{>>note<<}{#c1}'
    expect(spans[1]).toMatchObject({ kind: 'comment', inner: 'note', id: 'c1', start: 9, end: 24 });
  });

  it('parses a substitution into old/new', () => {
    const spans = tokenize('{~~old~>new~~}{#s1}');
    expect(spans[0]).toMatchObject({
      kind: 'substitution',
      oldText: 'old',
      newText: 'new',
      id: 's1',
    });
  });

  it('parses insertion and deletion', () => {
    expect(tokenize('{++add++} {--del--}').map((s) => s.kind)).toEqual(['insertion', 'deletion']);
  });

  it('ignores CriticMarkup inside fenced code blocks', () => {
    const spans = tokenize('```\n{>>literal<<}\n```\nreal {>>c<<}');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ inner: 'c' });
  });

  it('returns empty for plain text', () => {
    expect(tokenize('no marks here')).toEqual([]);
  });
});
