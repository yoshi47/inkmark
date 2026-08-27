import { describe, expect, it } from 'vitest';
import { nextId, noteFor, noteFreeHighlight, parse, rebuild, threadIds } from './index.js';

// The fixtures below are the shapes skills/inkmark/SKILL.md tells an agent to hand-write,
// and the hazards it tells one to avoid. The rest of this suite tests the parser on its own
// terms, so nothing in it notices when the skill drifts away from what the parser accepts —
// and the skill has no caller to break. This file is that tripwire.

const COMMENT = `これは {==ローカルファースト==}{>>この語の定義がまだ出てきていません<<}{#c8} なツールです。

---
comments:
  c8:
    by: AI
    at: 2026-08-26T10:00:00.000Z
    resolved: false
---
`;

const HIGHLIGHT = `Bare {==some text==}{#c8} here.

---
comments:
  c8:
    by: AI
    at: 2026-08-26T10:00:00.000Z
    resolved: false
---
`;

const THREAD = `inkmark is a {==local-first==}{>>What does this mean here?<<}{#c1} viewer.

---
comments:
  c1:
    by: user
    at: 2026-08-26T09:00:00.000Z
    resolved: true
  c2:
    by: AI
    re: c1
    at: 2026-08-26T10:00:00.000Z
    body: "The document lives on your machine; you and the agent edit the same file."
---
`;

const SUGGESTIONS = `{++added text++}{#s1} and {--removed text--}{#s2} and {~~old wording~>new wording~~}{#s3}

---
suggestions:
  s1:
    by: AI
    at: 2026-08-26T10:00:00.000Z
  s2:
    by: AI
    at: 2026-08-26T10:00:00.000Z
  s3:
    by: AI
    at: 2026-08-26T10:00:00.000Z
---
`;

const FENCED = `Before.

{==
\`\`\`ts
const x = 1;
\`\`\`
==}{>>this API is out of date<<}{#c9}

---
comments:
  c9:
    by: AI
    at: 2026-08-26T10:00:00.000Z
    resolved: false
---
`;

describe('the shapes SKILL.md tells an agent to write', () => {
  it('reads a comment as a highlight plus a note carrying the id', () => {
    const doc = parse(COMMENT);
    expect(doc.spans.map((s) => [s.kind, s.id])).toEqual([
      ['highlight', undefined],
      ['comment', 'c8'],
    ]);
    expect(noteFor(doc, 'c8')).toBe('この語の定義がまだ出てきていません');
    expect(doc.endmatter.comments['c8']?.by).toBe('AI');
  });

  it('reads a note-free highlight, whose own span carries the id', () => {
    const doc = parse(HIGHLIGHT);
    expect(doc.spans.map((s) => [s.kind, s.id])).toEqual([['highlight', 'c8']]);
    expect(noteFor(doc, 'c8')).toBeNull();
    expect(noteFreeHighlight(doc, 'c8')?.inner).toBe('some text');
  });

  it('reads a reply from the endmatter alone, with no mark of its own', () => {
    const doc = parse(THREAD);
    expect(doc.spans.map((s) => s.id)).toEqual([undefined, 'c1']);
    expect([...threadIds(doc, 'c1')]).toEqual(['c1', 'c2']);
    expect(doc.endmatter.comments['c2']?.re).toBe('c1');
    expect(doc.endmatter.comments['c2']?.resolved).toBeUndefined();
    expect(doc.endmatter.comments['c1']?.resolved).toBe(true);
  });

  it('reads all three suggestion kinds, splitting a substitution in two', () => {
    const doc = parse(SUGGESTIONS);
    expect(doc.spans.map((s) => [s.kind, s.id])).toEqual([
      ['insertion', 's1'],
      ['deletion', 's2'],
      ['substitution', 's3'],
    ]);
    expect(doc.spans[2]?.oldText).toBe('old wording');
    expect(doc.spans[2]?.newText).toBe('new wording');
    expect(Object.keys(doc.endmatter.suggestions)).toEqual(['s1', 's2', 's3']);
  });

  it('marks a fenced block from the outside', () => {
    const doc = parse(FENCED);
    expect(doc.spans.map((s) => [s.kind, s.id])).toEqual([
      ['highlight', undefined],
      ['comment', 'c9'],
    ]);
    expect(noteFor(doc, 'c9')).toBe('this API is out of date');
  });

  it('allocates the next id from the body marks and the endmatter together', () => {
    const doc = parse(THREAD);
    expect(nextId(doc, 'c')).toBe('c3');
    expect(nextId(parse(SUGGESTIONS), 's')).toBe('s4');
  });

  it.each([
    ['a comment', COMMENT],
    ['a note-free highlight', HIGHLIGHT],
    ['a thread with a reply', THREAD],
    ['the three suggestion kinds', SUGGESTIONS],
    ['a fenced block', FENCED],
  ])('survives a save of %s with its content intact', (_label, md) => {
    const doc = parse(md);
    const saved = rebuild(doc.body, doc.endmatter);
    const again = parse(saved);
    expect(again.body).toBe(doc.body);
    expect(again.endmatter).toEqual(doc.endmatter);
    expect(rebuild(again.body, again.endmatter)).toBe(saved);
  });

  // THREAD is missing here on purpose: its reply body is quoted, and a save unquotes a
  // string that parses the same either way, so it cannot come back byte-identical.
  it.each([
    ['a comment', COMMENT],
    ['a note-free highlight', HIGHLIGHT],
    ['the three suggestion kinds', SUGGESTIONS],
    ['a fenced block', FENCED],
  ])('rewrites %s byte for byte', (_label, md) => {
    const doc = parse(md);
    expect(rebuild(doc.body, doc.endmatter)).toBe(md);
  });

  it('drops quotes the YAML did not need, which is normalisation and not damage', () => {
    const doc = parse(THREAD);
    const saved = rebuild(doc.body, doc.endmatter);
    expect(saved).toContain('body: The document lives on your machine');
    expect(parse(saved).endmatter.comments['c2']?.body).toBe(doc.endmatter.comments['c2']?.body);
  });

  it('preserves an unrelated top-level key across a save', () => {
    const withTitle = COMMENT.replace('---\ncomments:', '---\ntitle: My Draft\ncomments:');
    const doc = parse(withTitle);
    expect(doc.endmatter.extra['title']).toBe('My Draft');
    expect(rebuild(doc.body, doc.endmatter)).toBe(withTitle);
  });
});

describe('the hazards SKILL.md tells an agent to avoid', () => {
  function reply(body: string): string {
    return COMMENT.replace(
      '    resolved: false\n',
      `    resolved: false\n  c9:\n    by: AI\n    re: c8\n    at: t\n    body: ${body}\n`,
    );
  }

  it('loses the whole endmatter, silently, when a body: holds an unquoted colon', () => {
    const doc = parse(reply('結論: これは危ない'));
    expect(Object.keys(doc.endmatter.comments)).toEqual([]);
    // Worse than an error: the block became prose, so nothing downstream can tell.
    expect(doc.endmatter.extra).toEqual({});
    expect(doc.body).toContain('comments:');
  });

  it('keeps the thread when the same text is quoted', () => {
    const doc = parse(reply('"結論: これは危ない"'));
    expect(Object.keys(doc.endmatter.comments)).toEqual(['c8', 'c9']);
    expect(doc.endmatter.comments['c9']?.body).toBe('結論: これは危ない');
  });

  it('ends a mark at the first closer, leaking the rest into the document', () => {
    const doc = parse('Leaky {==text with ==} inside==}{>>note<<}{#c1} here.\n');
    expect(doc.spans[0]?.inner).toBe('text with ');
    expect(doc.body.slice(doc.spans[0]?.end ?? 0)).toContain(' inside==}');
  });

  it('leaves a reply a reply, but reads its note from a stray body mark', () => {
    // Not "a second root": root-ness is `re`, and `re` is still there. The damage is that
    // the reply's text now renders in the prose and comes out with the thread on removal.
    const doc = parse(
      'Root {==x==}{>>root note<<}{#c1} and {==y==}{>>reply text<<}{#c2}.\n\n' +
        '---\ncomments:\n  c1:\n    by: user\n    at: t\n    resolved: false\n' +
        '  c2:\n    by: AI\n    re: c1\n    at: t\n    body: "reply text"\n---\n',
    );
    expect(doc.endmatter.comments['c2']?.re).toBe('c1');
    expect([...threadIds(doc, 'c1')]).toEqual(['c1', 'c2']);
    expect(doc.spans.some((s) => s.id === 'c2')).toBe(true);
  });

  it('does not protect a tilde fence: a mark written inside one is parsed for real', () => {
    // fence.ts accepts tilde fences when wrapping, but tokenize only skips plain
    // triple-backtick ones — which is why the skill says to keep marks out of fences
    // rather than trusting the parser to ignore them.
    const tilde = parse('~~~ts\nconst a = "{==not a mark==}";\n~~~\n');
    expect(tilde.spans.map((s) => s.kind)).toEqual(['highlight']);
    const backtick = parse('```ts\nconst a = "{==not a mark==}";\n```\n');
    expect(backtick.spans).toEqual([]);
  });
});
