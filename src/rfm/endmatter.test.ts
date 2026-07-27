import { describe, expect, it } from 'vitest';
import { parseEndmatter, rebuild, serializeEndmatter, splitEndmatter } from './endmatter.js';

const DOC = `Hello {>>hi<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-06-29T00:00:00.000Z"
`;

describe('endmatter', () => {
  it('splits body from endmatter without doubling the trailing newline', () => {
    const { body, endmatterRaws } = splitEndmatter(DOC);
    expect(body).toBe('Hello {>>hi<<}{#c1}\n');
    expect(endmatterRaws).toHaveLength(1);
    expect(endmatterRaws[0]).toContain('comments:');
  });

  it('reads a block closed by a trailing --- fence', () => {
    const { body, endmatterRaws } = splitEndmatter(`${DOC}---\n`);
    expect(body).toBe('Hello {>>hi<<}{#c1}\n');
    expect(parseEndmatter(endmatterRaws).comments['c1']).toEqual({
      by: 'user',
      at: '2026-06-29T00:00:00.000Z',
    });
  });

  it('reads a closed block that the file ends with a blank line after', () => {
    for (const tail of ['---\n\n', '---\n  \n', '---\n\n\n']) {
      const { body, endmatterRaws } = splitEndmatter(`${DOC}${tail}`);
      expect(body).toBe('Hello {>>hi<<}{#c1}\n');
      expect(Object.keys(parseEndmatter(endmatterRaws).comments)).toEqual(['c1']);
    }
  });

  it('takes the later entry when two blocks name the same id', () => {
    const e = parseEndmatter([
      'comments:\n  c1:\n    by: user\n    at: t1\n',
      'comments:\n  c1:\n    by: AI\n    at: t2\n',
    ]);
    expect(e.comments['c1']).toEqual({ by: 'AI', at: 't2' });
  });

  it('merges consecutive blocks, leaving none of them in the body', () => {
    const doubled =
      'Hi {>>a<<}{#c1} {>>b<<}{#c2}\n' +
      '\n---\ncomments:\n  c1:\n    by: AI\n    at: "t1"\n---\n' +
      '\n---\ncomments:\n  c2:\n    by: user\n    at: "t2"\n';
    const { body, endmatterRaws } = splitEndmatter(doubled);
    expect(body).toBe('Hi {>>a<<}{#c1} {>>b<<}{#c2}\n');
    const e = parseEndmatter(endmatterRaws);
    expect(Object.keys(e.comments)).toEqual(['c1', 'c2']);
  });

  it('peels a stack of three, and stops at a thematic break right in front of it', () => {
    function block(id: string): string {
      return `\n---\ncomments:\n  ${id}:\n    by: AI\n    at: t\n---\n`;
    }
    const doc = `Hi\n\n---\n${block('c1')}${block('c2')}${block('c3')}`;
    const { body, endmatterRaws } = splitEndmatter(doc);
    expect(body).toBe('Hi\n\n---\n');
    expect(Object.keys(parseEndmatter(endmatterRaws).comments)).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps entries from every block when the blocks hold different kinds', () => {
    const e = parseEndmatter([
      'comments:\n  c1:\n    by: user\n    at: "t"\n',
      'suggestions:\n  s1:\n    by: AI\n    at: "t"\n',
    ]);
    expect(Object.keys(e.comments)).toEqual(['c1']);
    expect(Object.keys(e.suggestions)).toEqual(['s1']);
  });

  it('leaves a document ending in a comments list to the body', () => {
    const notes = '# Notes\n\nSome prose.\n\n---\n\ncomments:\n  - ship it\n  - looks good\n';
    const { body, endmatterRaws } = splitEndmatter(notes);
    expect(body).toBe(notes);
    expect(endmatterRaws).toEqual([]);
  });

  it('carries a top-level key it does not own through the round trip', () => {
    const withTitle = `Hi {>>hi<<}{#c1}\n\n---\ntitle: my review\ncomments:\n  c1:\n    by: user\n    at: t\n---\n`;
    const { body, endmatterRaws } = splitEndmatter(withTitle);
    const e = parseEndmatter(endmatterRaws);
    expect(e.extra).toEqual({ title: 'my review' });
    expect(rebuild(body, e)).toContain('title: my review');
  });

  it('leaves a block alone when prose follows it', () => {
    const trailingProse = `${DOC}---\n\n## Appendix\n\nSee you.\n`;
    const { body, endmatterRaws } = splitEndmatter(trailingProse);
    expect(body).toBe(trailingProse);
    expect(endmatterRaws).toEqual([]);
  });

  it('returns no endmatter when there is no --- block', () => {
    const { body, endmatterRaws } = splitEndmatter('Just text\n');
    expect(body).toBe('Just text\n');
    expect(endmatterRaws).toEqual([]);
  });

  it('parses comments and suggestions, defaulting empty', () => {
    const e = parseEndmatter(['comments:\n  c1:\n    by: user\n    at: "t"\n']);
    expect(e.comments['c1']).toEqual({ by: 'user', at: 't' });
    expect(e.suggestions).toEqual({});
  });

  it('serializes empty endmatter to an empty string', () => {
    expect(serializeEndmatter({ comments: {}, suggestions: {}, extra: {} })).toBe('');
  });

  it('round-trips through serialize', () => {
    const e = parseEndmatter(splitEndmatter(DOC).endmatterRaws);
    const again = parseEndmatter([serializeEndmatter(e)]);
    expect(again).toEqual(e);
  });

  it('degrades to empty on malformed YAML', () => {
    expect(parseEndmatter([':\n  bad: ['])).toEqual({ comments: {}, suggestions: {}, extra: {} });
  });

  it('splits at the LAST --- fence when the body itself contains ---', () => {
    const docWithMiddleFence = 'A\n\n---\nB\n\n---\ncomments:\n  c1:\n    by: user\n    at: "t"\n';
    const { body, endmatterRaws } = splitEndmatter(docWithMiddleFence);
    expect(body).toBe('A\n\n---\nB\n');
    expect(endmatterRaws[0]).toContain('comments:');
  });

  it('rebuilds to a single closed block, unchanged on a second pass', () => {
    const once = rebuild('A\n\n---\nB\n', {
      comments: { c1: { by: 'user', at: 't' } },
      suggestions: {},
      extra: {},
    });
    expect(once).toBe('A\n\n---\nB\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n---\n');
    const { body, endmatterRaws } = splitEndmatter(once);
    expect(rebuild(body, parseEndmatter(endmatterRaws))).toBe(once);
  });
});
