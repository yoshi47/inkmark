import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';
import { applySuggestion } from './suggest.js';

const sub = 'say {~~old~>new~~}{#s1} now\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: t\n';

describe('applySuggestion', () => {
  it('accept substitution → new text, endmatter dropped entirely', () => {
    const out = applySuggestion(sub, 's1', 'accept');
    expect(out).toContain('say new now');
    expect(out).not.toContain('---');
    expect(out).not.toContain('{}');
  });

  it('reject substitution → old text', () => {
    expect(applySuggestion(sub, 's1', 'reject')).toContain('say old now');
  });

  it('accept insertion keeps text; reject insertion drops it', () => {
    const ins = 'a {++b++}{#s1} c\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: t\n';
    expect(applySuggestion(ins, 's1', 'accept')).toContain('a b c');
    expect(applySuggestion(ins, 's1', 'reject')).toContain('a  c');
  });

  it('accept deletion removes text; reject deletion keeps it', () => {
    const del = 'keep {--gone--}{#s1} text\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: t\n';
    expect(applySuggestion(del, 's1', 'accept')).toContain('keep  text');
    expect(applySuggestion(del, 's1', 'reject')).toContain('keep gone text');
  });

  it('returns input unchanged when id is absent', () => {
    expect(applySuggestion(sub, 'nonexistent', 'accept')).toBe(sub);
  });

  it('applying s1 leaves s2 intact in endmatter, s1 is gone', () => {
    const two =
      'a {++b++}{#s1} c {--d--}{#s2} e\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: t\n  s2:\n    by: user\n    at: t\n';
    const out = applySuggestion(two, 's1', 'accept');
    const doc = parse(out);
    expect(doc.endmatter.suggestions['s2']).toBeDefined();
    expect(doc.endmatter.suggestions['s1']).toBeUndefined();
  });
});
