import { describe, expect, it } from 'vitest';
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
});
