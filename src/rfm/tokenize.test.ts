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
  it('returns empty for a bare unterminated marker', () => {
    expect(tokenize('{>>oops')).toEqual([]);
  });

  it('skips an unterminated marker and parses the subsequent complete one', () => {
    const spans = tokenize('before {>>oops after {>>closed<<}');
    expect(spans).toHaveLength(1);
    const first = spans[0];
    expect(first).toMatchObject({ kind: 'comment', inner: 'oops after {>>closed' });
  });

  it('keeps an opener sequence that appears inside a comment body', () => {
    const body = '{>>use {>> to open<<}{#c1}';
    const spans = tokenize(body);
    expect(spans).toHaveLength(1);
    const first: (typeof spans)[number] | undefined = spans[0];
    if (first === undefined) throw new Error('expected span');
    expect(first).toMatchObject({ kind: 'comment', inner: 'use {>> to open', id: 'c1' });
  });

  it('does not treat a closing fence with trailing text as a fence boundary', () => {
    // ``` not-a-fence does NOT match the tightened closing-fence pattern,
    // so markers inside the "unclosed" block are still tokenized.
    const spans = tokenize('```\n{>>inside<<}\n``` not-a-fence\nafter {>>real<<}');
    expect(spans).toHaveLength(2);
    const first = spans[0];
    const second = spans[1];
    expect(first).toMatchObject({ inner: 'inside' });
    expect(second).toMatchObject({ inner: 'real' });
  });
});
