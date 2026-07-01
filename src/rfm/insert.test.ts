import { describe, expect, it } from 'vitest';
import { addReply, insertComment, setResolved } from './insert.js';
import { parse } from './parse.js';

describe('insertComment', () => {
  it('wraps the selected body range and records endmatter', () => {
    const { md: out, id } = insertComment('Hello world\n', [6, 11], 'why?', 'user', 't');
    expect(id).toBe('c1');
    expect(out).toContain('Hello {==world==}{>>why?<<}{#c1}');
    const c1 = parse(out).endmatter.comments['c1'];
    expect(c1).toEqual({ by: 'user', at: 't', resolved: false });
  });

  it('allocates a fresh id when one already exists', () => {
    const md = 'a {==x==}{>>n<<}{#c1} b\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n';
    expect(insertComment(md, [0, 1], 'second', 'AI', 't2').id).toBe('c2');
  });

  it('rejects a comment body containing a closer sequence', () => {
    expect(() => insertComment('hi\n', [0, 2], 'bad <<} body', 'user', 't')).toThrow();
  });

  it('rejects a selection containing a closer sequence', () => {
    expect(() => insertComment('a ==} b\n', [2, 5], 'note', 'user', 't')).toThrow();
  });

  it('throws when expectedText does not match the slice', () => {
    // 'hello world\n'.slice(0, 5) === 'hello', but we pass 'XXXXX'
    expect(() => insertComment('hello world\n', [0, 5], 'c', 'user', 't', 'XXXXX')).toThrow(
      'selection moved',
    );
  });

  it('succeeds when expectedText matches the slice', () => {
    // 'hello world\n'.slice(0, 5) === 'hello'
    const result = insertComment('hello world\n', [0, 5], 'c', 'user', 't', 'hello');
    expect(result).toMatchObject({ id: 'c1' });
  });
});

describe('insertComment overlap guard', () => {
  it('throws when the range overlaps an existing mark', () => {
    const md = 'x {==m==}{#c1} y';
    // offsets of "m" inner are inside the existing highlight span -> must refuse
    expect(() => insertComment(md, [5, 6], 'note', 'user', '2026-07-01T00:00:00.000Z')).toThrow(
      /overlap/,
    );
  });

  it('allows a non-overlapping range in an already-marked doc', () => {
    const md = 'x {==m==}{#c1} yy';
    const start = md.indexOf('yy');
    const out = insertComment(md, [start, start + 2], 'note', 'user', '2026-07-01T00:00:00.000Z');
    expect(out.md).toContain('{==yy==}');
  });
});

describe('addReply / setResolved', () => {
  const base = 'x {==y==}{>>q<<}{#c1} z\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n';

  it('adds a reply as a new id with re', () => {
    const { md, id } = addReply(base, 'c1', 'answer', 'AI', 't2');
    expect(id).toBe('c2');
    const c2 = parse(md).endmatter.comments['c2'];
    expect(c2).toEqual({ by: 'AI', at: 't2', re: 'c1', body: 'answer' });
  });

  it('marks a thread resolved', () => {
    const c1 = parse(setResolved(base, 'c1', true)).endmatter.comments['c1'];
    expect(c1?.resolved).toBe(true);
  });
});
