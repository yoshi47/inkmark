import { describe, expect, it } from 'vitest';
import { parseEndmatter, serializeEndmatter, splitEndmatter } from './endmatter.js';

const DOC = `Hello {>>hi<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-06-29T00:00:00.000Z"
`;

describe('endmatter', () => {
  it('splits body from endmatter without doubling the trailing newline', () => {
    const { body, endmatterRaw } = splitEndmatter(DOC);
    expect(body).toBe('Hello {>>hi<<}{#c1}\n');
    expect(endmatterRaw).toContain('comments:');
  });

  it('returns null endmatter when there is no --- block', () => {
    const { body, endmatterRaw } = splitEndmatter('Just text\n');
    expect(body).toBe('Just text\n');
    expect(endmatterRaw).toBeNull();
  });

  it('parses comments and suggestions, defaulting empty', () => {
    const e = parseEndmatter('comments:\n  c1:\n    by: user\n    at: "t"\n');
    expect(e.comments['c1']).toEqual({ by: 'user', at: 't' });
    expect(e.suggestions).toEqual({});
  });

  it('serializes empty endmatter to an empty string', () => {
    expect(serializeEndmatter({ comments: {}, suggestions: {} })).toBe('');
  });

  it('round-trips through serialize', () => {
    const e = parseEndmatter(splitEndmatter(DOC).endmatterRaw);
    const again = parseEndmatter(serializeEndmatter(e));
    expect(again).toEqual(e);
  });

  it('degrades to empty on malformed YAML', () => {
    expect(parseEndmatter(':\n  bad: [')).toEqual({ comments: {}, suggestions: {} });
  });
});
