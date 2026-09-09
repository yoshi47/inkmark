import { describe, expect, it } from 'vitest';
import { parseEndmatter, rebuild, serializeEndmatter, splitEndmatter } from './endmatter.js';
import { parse } from './parse.js';

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
    expect(rebuild(body, e, '\n')).toContain('title: my review');
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
    const once = rebuild(
      'A\n\n---\nB\n',
      { comments: { c1: { by: 'user', at: 't' } }, suggestions: {}, extra: {} },
      '\n',
    );
    expect(once).toBe('A\n\n---\nB\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n---\n');
    const { body, endmatterRaws } = splitEndmatter(once);
    expect(rebuild(body, parseEndmatter(endmatterRaws), '\n')).toBe(once);
  });
});

describe('unreadable endmatter', () => {
  // Peeling stops here, so the block and everything before it stays in the body as prose.
  // Unreported, that reads to the user as their comment table turning into text.
  it('reports a block whose YAML will not parse', () => {
    const broken = 'Body text\n\n---\ncomments:\n  c1:\n   by: user\n     at: bad indent\n---\n';
    const { body, endmatterRaws, unreadable } = splitEndmatter(broken);
    expect(endmatterRaws).toEqual([]);
    expect(body).toContain('comments:');
    expect(unreadable).not.toBeNull();
  });

  it('counts one broken block once, not once per candidate fence', () => {
    const broken =
      'Body\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n---\n\n---\ncomments:\n  c2:\n   by: user\n     at: bad\n---\n';
    expect(splitEndmatter(broken).unreadable).not.toBeNull();
  });

  it("stays silent for an author's own horizontal rule", () => {
    const prose = 'Chapter one\n\n---\n\nChapter two\n';
    expect(splitEndmatter(prose).unreadable).toBeNull();
  });

  it('stays silent for a document ending in prose under a comments heading', () => {
    const prose = 'Notes\n\n---\ncomments:\n  - a bullet, not a table\n';
    expect(splitEndmatter(prose).unreadable).toBeNull();
  });

  it('says nothing about a document it can read', () => {
    expect(splitEndmatter(DOC).unreadable).toBeNull();
  });
});

describe('endmatter false positives', () => {
  // Prose after a horizontal rule is invalid YAML far more often than not, and a badge
  // that lights on healthy documents is a badge nobody reads when it finally matters.
  for (const [name, tail] of [
    ['inline code', 'Run `npm install` first.'],
    ['an @ mention', '@someone said hi.'],
    ['a colon mid-sentence', 'Warning: do this: never that.'],
    ['emphasis', '*emphasis* and more text.'],
    ['a leading tab', '\tindented with a tab'],
  ] as const) {
    it(`stays silent for ${name} after an author's rule`, () => {
      expect(splitEndmatter(`Intro\n\n---\n${tail}\n`).unreadable).toBeNull();
    });
  }

  it('stays silent for prose after a rule in a document that also has real endmatter', () => {
    const doc = `# Title\n\n---\n\nUse \`npm install\` here.\n${DOC.slice(DOC.indexOf('\n---\n'))}`;
    const { endmatterRaws, unreadable } = splitEndmatter(doc);
    expect(endmatterRaws).toHaveLength(1);
    expect(unreadable).toBeNull();
  });
});

describe('CRLF documents', () => {
  const CRLF =
    'Hello {>>hi<<}{#c1}\r\n\r\n---\r\ncomments:\r\n  c1:\r\n    by: user\r\n    at: t\r\n---\r\n';

  it('finds the endmatter a CRLF file carries', () => {
    const doc = parse(CRLF);
    expect(doc.eol).toBe('\r\n');
    expect(doc.endmatter.comments['c1']?.by).toBe('user');
    expect(doc.body).not.toContain('\r');
  });

  it('writes a CRLF file back with CRLF endings', () => {
    const doc = parse(CRLF);
    // Without this the test passes on the bug it guards: a parser that finds no endmatter
    // hands the whole file back as `body`, and rebuild returns it untouched.
    expect(doc.body).not.toContain('comments:');
    const saved = rebuild(doc.body, doc.endmatter, doc.eol);
    expect(saved).toBe(CRLF);
    expect(saved).not.toMatch(/[^\r]\n/);
  });

  // The bug this closes: the fence regex never matched `---\r\n`, so every save appended
  // another block to a document that already had one.
  it('does not grow a second endmatter block on repeated saves', () => {
    let md = CRLF;
    for (let i = 0; i < 3; i++) {
      const doc = parse(md);
      md = rebuild(doc.body, doc.endmatter, doc.eol);
    }
    expect(md.split('---').length - 1).toBe(2);
    expect(parse(md).endmatter.comments['c1']?.by).toBe('user');
  });

  // Agents write LF straight into files humans saved as CRLF, so a mixed document is the
  // ordinary case. Going by "any CRLF anywhere" would rewrite every line of this one.
  it('keeps an LF document on LF when one CRLF line is mixed in', () => {
    const mixed = 'Line one\nline two\r\nline three\n';
    const doc = parse(mixed);
    expect(doc.eol).toBe('\n');
    expect(rebuild(doc.body, doc.endmatter, doc.eol)).not.toContain('\r');
  });

  it('carries a multi-line comment body through a CRLF round trip', () => {
    const md = parse('Body\n').endmatter;
    md.comments['c1'] = { by: 'user', at: 't', body: 'first line\nsecond line' };
    const saved = rebuild('Body\n', md, '\r\n');
    expect(saved).not.toMatch(/[^\r]\n/);
    expect(parse(saved).endmatter.comments['c1']?.body).toBe('first line\nsecond line');
  });

  // A CR left in `body` would be a third kind of line ending under a type that promises
  // two, and the tokenizer's closing-fence regex stops matching a line that carries one.
  it('folds a lone CR rather than leaving a third line ending in the body', () => {
    const doc = parse('a\rb\n');
    expect(doc.eol).toBe('\n');
    expect(doc.body).not.toContain('\r');
    expect(doc.mixedEol).toBe(1);
  });

  // `\r\r\n` used to lose a byte: replacing only `\r\n` left the first CR behind, and it
  // then rejoined the following newline as a CRLF nobody wrote.
  it('does not let a CR beside a CRLF swallow it', () => {
    const doc = parse('a\r\nb\r\r\nc\r\n');
    expect(doc.eol).toBe('\r\n');
    expect(doc.body).toBe('a\nb\n\nc\n');
    expect(rebuild(doc.body, doc.endmatter, doc.eol)).toBe('a\r\nb\r\n\r\nc\r\n');
  });
});

describe('mixed line endings', () => {
  // The rule cuts both ways, so both directions are pinned: whichever ending came first
  // wins, and every line that loses is counted rather than left for a diff to reveal.
  it('counts the LF lines an agent appended to a CRLF file', () => {
    const doc = parse('Title\r\nagent added this\nhuman line\r\n');
    expect(doc.eol).toBe('\r\n');
    expect(doc.mixedEol).toBe(1);
    expect(rebuild(doc.body, doc.endmatter, doc.eol)).toBe(
      'Title\r\nagent added this\r\nhuman line\r\n',
    );
  });

  it('counts the CRLF lines mixed into an LF file', () => {
    const doc = parse('Line one\nline two\r\nline three\n');
    expect(doc.eol).toBe('\n');
    expect(doc.mixedEol).toBe(1);
  });

  it('says nothing about a document that is consistent', () => {
    expect(parse('a\nb\n').mixedEol).toBe(0);
    expect(parse('a\r\nb\r\n').mixedEol).toBe(0);
    expect(parse('no line endings at all').mixedEol).toBe(0);
  });

  // Not a real line ending to go by, so LF is the fallback; nothing else could be right.
  it('treats a file with no line ending at all as LF', () => {
    expect(parse('single line').eol).toBe('\n');
  });
});
