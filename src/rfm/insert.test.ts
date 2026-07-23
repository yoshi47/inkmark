import { describe, expect, it } from 'vitest';
import {
  addReply,
  insertComment,
  insertHighlight,
  removeComment,
  removeHighlight,
  setResolved,
} from './insert.js';
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

describe('insertHighlight', () => {
  it('wraps the selected range without a comment note', () => {
    const { md: out, id } = insertHighlight('Hello world\n', [6, 11], 'user', 't');
    expect(id).toBe('c1');
    expect(out).toContain('Hello {==world==}{#c1}');
    expect(out).not.toContain('{>>');
  });

  it('records endmatter so the mark shows up as a thread', () => {
    const out = insertHighlight('Hello world\n', [6, 11], 'user', 't').md;
    expect(parse(out).endmatter.comments['c1']).toEqual({ by: 'user', at: 't', resolved: false });
  });

  it('parses back as a highlight span carrying the id', () => {
    const out = insertHighlight('Hello world\n', [6, 11], 'user', 't').md;
    const span = parse(out).spans.find((s) => s.id === 'c1');
    expect(span).toMatchObject({ kind: 'highlight', inner: 'world' });
  });

  // id allocation, the closer guard and the overlap guard run in prepareMark,
  // shared with insertComment and covered by its tests above.
  it('throws when expectedText does not match the slice', () => {
    expect(() => insertHighlight('hello world\n', [0, 5], 'user', 't', 'XXXXX')).toThrow(
      'selection moved',
    );
  });

  it('refuses an empty range instead of writing an unreachable {====}', () => {
    expect(() => insertHighlight('abc\n', [1, 1], 'user', 't')).toThrow('empty selection');
    expect(() => insertComment('abc\n', [1, 1], 'note', 'user', 't')).toThrow('empty selection');
  });

  it('allows a range that touches an existing mark without overlapping it', () => {
    const md = 'x {==m==}{#c1} y';
    expect(insertHighlight(md, [0, 2], 'user', 't').md).toContain('{==x ==}{#c2}{==m==}{#c1}');
  });
});

describe('removeHighlight', () => {
  function highlightOnly(extra = ''): string {
    return `Some {==target text==}{#c1} here.\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n${extra}`;
  }

  it('leaves the plain text behind and drops the entry', () => {
    const out = removeHighlight(highlightOnly(), 'c1');
    expect(out).toContain('Some target text here.');
    expect(parse(out).endmatter.comments['c1']).toBeUndefined();
  });

  it('keeps unrelated comments in the endmatter', () => {
    const md = highlightOnly('  c2:\n    by: AI\n    at: t2\n');
    expect(parse(removeHighlight(md, 'c1')).endmatter.comments['c2']).toBeDefined();
  });

  it('refuses a mark whose note follows the id, leaving the note intact', () => {
    const md =
      'Some {==sel==}{#c1}{>>note<<} here.\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n';
    expect(removeHighlight(md, 'c1')).toBe(md);
  });

  it('refuses a commented pair rather than splicing its note into the body', () => {
    const md =
      'Some {==sel==}{>>note<<}{#c1} here.\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n';
    expect(removeHighlight(md, 'c1')).toBe(md);
  });

  it('refuses a mark whose note lives in the endmatter', () => {
    const md = highlightOnly().replace(
      '    at: t\n',
      '    at: t\n    body: I think this is wrong\n',
    );
    expect(removeHighlight(md, 'c1')).toBe(md);
  });

  it('takes the replies of the thread down with it', () => {
    const md = highlightOnly('  c2:\n    by: AI\n    at: t2\n    re: c1\n    body: later note\n');
    const out = removeHighlight(md, 'c1');
    expect(out).toContain('Some target text here.');
    expect(parse(out).endmatter.comments['c2']).toBeUndefined();
  });

  it('ignores a reply id that marks nothing in the body', () => {
    const md = highlightOnly('  c2:\n    by: AI\n    at: t2\n    re: c1\n    body: later note\n');
    expect(removeHighlight(md, 'c2')).toBe(md);
  });

  it('terminates on a reply cycle rather than looping', () => {
    const md = highlightOnly(
      '  c2:\n    by: AI\n    at: t2\n    re: c3\n' + '  c3:\n    by: AI\n    at: t3\n    re: c2\n',
    );
    const out = parse(removeHighlight(md, 'c1'));
    // c2 and c3 answer each other, not c1, so the cycle is walked but not entered
    expect(out.endmatter.comments['c2']).toBeDefined();
    expect(out.endmatter.comments['c1']).toBeUndefined();
  });
});

describe('removeComment', () => {
  const entry = '\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n';

  it('unwraps a note carrying the id and drops the entry', () => {
    const out = removeComment(`Some {==sel==}{>>note<<}{#c1} here.${entry}`, 'c1');
    expect(out).toBe('Some sel here.\n');
  });

  it('unwraps a mark whose note follows the id', () => {
    const out = removeComment(`Some {==sel==}{#c1}{>>note<<} here.${entry}`, 'c1');
    expect(out).toBe('Some sel here.\n');
  });

  it('unwraps a mark whose note lives in the endmatter', () => {
    const md = `Some {==sel==}{#c1} here.${entry}    body: I think this is wrong\n`;
    expect(removeComment(md, 'c1')).toBe('Some sel here.\n');
  });

  it('removes a standalone note that marks no text', () => {
    // The mark stood between two spaces, so removing it leaves both behind.
    expect(removeComment(`Some {>>note<<}{#c1} here.${entry}`, 'c1')).toBe('Some  here.\n');
  });

  it('takes replies down to any depth', () => {
    const md =
      `Some {==sel==}{>>note<<}{#c1} here.${entry}` +
      '  c2:\n    by: AI\n    at: t2\n    re: c1\n    body: reply\n' +
      '  c3:\n    by: user\n    at: t3\n    re: c2\n    body: reply to the reply\n' +
      '  c4:\n    by: AI\n    at: t4\n    body: unrelated\n';
    const out = parse(removeComment(md, 'c1'));
    expect(out.endmatter.comments['c2']).toBeUndefined();
    expect(out.endmatter.comments['c3']).toBeUndefined();
    expect(out.endmatter.comments['c4']).toBeDefined();
  });

  it('removes an inline reply span along with its entry', () => {
    const md =
      `Some {==sel==}{>>note<<}{#c1} here.{>>reply<<}{#c2}${entry}` +
      '  c2:\n    by: AI\n    at: t2\n    re: c1\n';
    expect(removeComment(md, 'c1')).toBe('Some sel here.\n');
  });

  it('leaves a detached note alone, mark and all', () => {
    // A note the mark does not touch belongs to whoever wrote it, so neither
    // noteFor nor removal reaches it — which leaves c1 note-free, and note-free
    // marks are removeHighlight's.
    const md = `Some {==sel==}{#c1} and {>>note<<} here.${entry}`;
    expect(removeComment(md, 'c1')).toBe(md);
    expect(removeHighlight(md, 'c1')).toBe(`Some sel and {>>note<<} here.\n`);
  });

  it('leaves a neighbouring mark with its own id alone', () => {
    const md = `Some {==a==}{#c9}{==b==}{>>note<<}{#c1} here.${entry}`;
    expect(removeComment(md, 'c1')).toBe('Some {==a==}{#c9}b here.\n');
  });

  it('leaves the commented pair that follows it alone', () => {
    const c2 = '  c2:\n    by: AI\n    at: t2\n';
    const md = `A{==x==}{>>n1<<}{#c1}{==y==}{>>n2<<}{#c2} B.${entry}${c2}`;
    expect(removeComment(md, 'c1')).toBe(`Ax{==y==}{>>n2<<}{#c2} B.\n\n---\ncomments:\n${c2}`);
  });

  it('keeps a suggestions-only endmatter after the last comment goes', () => {
    const md = `Some {==sel==}{>>note<<}{#c1} here.${entry}suggestions:\n  s1:\n    by: AI\n    at: t\n`;
    const out = removeComment(md, 'c1');
    expect(out).toContain('suggestions:');
    expect(out).not.toContain('comments:');
  });

  it('sweeps a root entry whose mark is already gone', () => {
    const md = `Some plain text.${entry}    body: orphaned note\n`;
    expect(removeComment(md, 'c1')).toBe('Some plain text.\n');
  });

  it('leaves a mark quoted inside a fenced code block untouched', () => {
    // The tokenizer skips fences, so the mark owns no span — but it is still
    // there in the body, and sweeping the entry would strand it forever.
    const md = `Sample:\n\n\`\`\`\n{==sel==}{>>note<<}{#c1}\n\`\`\`\n${entry}`;
    expect(removeComment(md, 'c1')).toBe(md);
  });

  it('leaves a note-free highlight to removeHighlight', () => {
    const md = `Some {==sel==}{#c1} here.${entry}`;
    expect(removeComment(md, 'c1')).toBe(md);
  });

  it('ignores an unknown id and a c-prefixed id sitting on a suggestion', () => {
    const md = `Some {++added++}{#c1} here.${entry}    body: I suggest this\n`;
    expect(removeComment(md, 'c1')).toBe(md);
    expect(removeComment(md, 'c9')).toBe(md);
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
