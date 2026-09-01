import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../rfm/tokenize.js';
import { leakedDelimitersIn } from './delimiterLeaks.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';

/**
 * Renders, and asserts how many delimiters reach the reader — zero unless the
 * case names a number.
 *
 * Counted through the DOM, not the HTML string: rehype-stringify escapes `<`,
 * so a string match never sees `<<}` and every note in this file would be
 * checked for only half its delimiters. Parsing also gives the check the same
 * code/pre exclusion the app runs, rather than a second copy of that policy.
 *
 * `expectLeaks` asserts a count, not a permission: a case whose fallback
 * degrades fails, and so does one whose underlying bug someone fixed.
 */
/** Blocks a <mark> swallowed whole — the shape the BLOCK guard exists to prevent. */
function swallowedBlocks(html: string): number {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.querySelectorAll(
    'mark[data-cm-id] > :is(p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,table,hr,dl)',
  ).length;
}

function render(src: string, opts?: { expectLeaks: number }): string {
  const html = remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rehypeCriticMarkup(tokenize(src)))
    .use(rehypeStringify)
    .processSync(src)
    .toString();
  const host = document.createElement('div');
  host.innerHTML = html;
  expect(leakedDelimitersIn(host)).toHaveLength(opts?.expectLeaks ?? 0);
  return html;
}

describe('rehypeCriticMarkup', () => {
  it('renders a plain highlight as <mark> without leaking delimiters', () => {
    const html = render('a {==just highlight==} b');
    expect(html).toContain('<mark data-cm-kind="highlight">just highlight</mark>');
    expect(html).not.toContain('{==');
    expect(html).not.toContain('==}');
  });

  it('preserves inner markdown inside a highlight (the bug this fixes)', () => {
    const html = render('foo {==bar **bold** baz==}{#c9} tail');
    // inner bold survives, wrapped by the mark, no literal braces:
    expect(html).toMatch(
      /<mark data-cm-kind="highlight" data-cm-id="c9">bar <strong>bold<\/strong> baz<\/mark>/,
    );
    expect(html).not.toContain('{#c9}');
    expect(html).not.toContain('{==');
  });

  it('keeps a note out of the body and hands its id to the highlight', () => {
    const html = render('x {==sel==}{>>note<<}{#c1} y');
    expect(html).toContain(
      '<mark data-cm-kind="highlight" data-cm-id="c1" data-cm-note="">sel</mark>',
    );
    expect(html).not.toContain('>note<');
    expect(html).not.toContain('{>>');
    expect(html).not.toContain('<<}');
  });

  it('marks a highlight as noted when the note trails its id', () => {
    const html = render('x {==sel==}{#c1}{>>note<<} y');
    expect(html).toContain(
      '<mark data-cm-kind="highlight" data-cm-id="c1" data-cm-note="">sel</mark>',
    );
    expect(html).not.toContain('>note<');
  });

  // theme.css colours a highlight by whether it has a note, so a standalone one
  // must stay free of data-cm-note while still carrying the id a click needs.
  it('leaves a standalone highlight note-free', () => {
    const html = render('x {==sel==}{#c1} y');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">sel</mark>');
    expect(html).not.toContain('data-cm-note');
  });

  it('renders a note with no highlight as a marker', () => {
    const html = render('x {>>memo<<}{#c3} y');
    expect(html).toContain('<mark data-cm-kind="comment" data-cm-id="c3">💬</mark>');
    expect(html).not.toContain('memo');
  });

  // Nothing in the sidebar can speak for a note with no id, so taking its text
  // out of the body would take it out of the app.
  it('leaves an id-less note where it is', () => {
    expect(render('x {==sel==}{>>note<<} y')).toContain('<mark data-cm-kind="comment">note</mark>');
    expect(render('x {>>memo<<} y')).toContain('<mark data-cm-kind="comment">memo</mark>');
  });

  // Two ids are two marks an agent wrote, not a highlight and its note.
  it('keeps a note carrying its own id apart from the highlight before it', () => {
    const html = render('x {==sel==}{#c1}{>>note<<}{#c2} y');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">sel</mark>');
    expect(html).toContain('<mark data-cm-kind="comment" data-cm-id="c2">💬</mark>');
  });

  it('renders insertion and deletion', () => {
    const html = render('a {++ins++}{#s1} b {--del--}{#s2} c');
    expect(html).toContain('<mark data-cm-kind="insertion" data-cm-id="s1">ins</mark>');
    expect(html).toContain('<mark data-cm-kind="deletion" data-cm-id="s2">del</mark>');
  });

  it('leaves substitution untouched (not rendered as a mark in v1)', () => {
    const html = render('a {~~old~>new~~}{#s5} b');
    expect(html).not.toContain('data-cm-kind="substitution"');
  });

  it('wraps a fenced code block marked on lines of its own', () => {
    const html = render(
      'intro\n\n{==\n```js\nconst a = 1;\n```\n==}{>>looks wrong<<}{#c1}\n\nafter\n',
    );
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1" data-cm-note=""><pre>');
    expect(html).toContain('const a = 1;\n</code></pre></mark>');
    expect(html).not.toContain('{==');
    expect(html).not.toContain('looks wrong');
  });

  it('leaves no empty paragraph where a delimiter line stood', () => {
    // The closing "==}…{#c1}" line is a paragraph of its own; dropping only its text would leave
    // a <p></p> the document never had. A note-less mark takes the other path through delims —
    // two delimiters rather than one spanning pair — so both shapes are pinned.
    expect(render('{==\n```js\na\n```\n==}{>>note<<}{#c1}\n')).not.toContain('<p></p>');
    expect(render('{==\n```js\na\n```\n==}{#c1}\n')).not.toContain('<p></p>');
  });

  it('handles a second mark elsewhere in an already-marked paragraph', () => {
    const html = render('one {==first==}{#c1} two {==second==}{#c2} three');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">first</mark>');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c2">second</mark>');
  });

  describe('inside nested containers', () => {
    it('renders a mark in a tight list item', () => {
      const html = render('- a {==sel==}{#c1} b\n');
      expect(html).toContain(
        '<li>a <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark> b</li>',
      );
    });

    it('renders a mark in a loose list item, including a continuation paragraph', () => {
      const html = render('1. one\n\n   two {==sel==}{#c1} three\n\n2. four\n');
      expect(html).toContain(
        '<p>two <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark> three</p>',
      );
    });

    it('renders a mark in a table cell', () => {
      const html = render('| h |\n| --- |\n| a {==sel==}{#c1} b |\n');
      expect(html).toContain(
        '<td>a <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark> b</td>',
      );
    });

    it('renders a mark in a table header cell', () => {
      const html = render('| a {==sel==}{#c1} b |\n| --- |\n| x |\n');
      expect(html).toContain(
        '<th>a <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark> b</th>',
      );
    });

    it('renders a mark nested in a list inside a list', () => {
      const html = render('- outer\n  - inner {==sel==}{#c1}\n');
      expect(html).toContain(
        '<li>inner <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark></li>',
      );
    });

    it('renders a mark in a heading', () => {
      const html = render('# head {==sel==}{#c1} tail\n');
      expect(html).toContain(
        '<h1>head <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark> tail</h1>',
      );
    });

    it('renders a mark in a blockquote nested in a list item', () => {
      const html = render('- outer\n\n  > quoted {==sel==}{#c1} text\n');
      expect(html).toContain(
        '<p>quoted <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark> text</p>',
      );
    });

    it('renders a mark in a task list item', () => {
      const html = render('- [ ] todo {==sel==}{#c1} rest\n');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">sel</mark>');
    });

    it('renders a mark in a footnote definition', () => {
      const html = render('body[^1]\n\n[^1]: note {==sel==}{#c1} tail\n');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">sel</mark>');
    });

    it('renders a note marker and a suggestion inside a list item', () => {
      const html = render('- a {>>memo<<}{#c3} b {++ins++}{#s1} c {--del--}{#s2} d\n');
      expect(html).toContain('<mark data-cm-kind="comment" data-cm-id="c3">💬</mark>');
      expect(html).toContain('<mark data-cm-kind="insertion" data-cm-id="s1">ins</mark>');
      expect(html).toContain('<mark data-cm-kind="deletion" data-cm-id="s2">del</mark>');
      expect(html).not.toContain('memo');
    });

    it('renders a note marker inside a table header cell', () => {
      const html = render('| a {>>memo<<}{#c3} b |\n| --- |\n| x |\n');
      expect(html).toContain('<mark data-cm-kind="comment" data-cm-id="c3">💬</mark>');
      expect(html).not.toContain('memo');
    });

    // Marking each item's text and leaving the structure alone: a <mark> directly under
    // <ul> or <tr> is invalid, and the list would stop counting the item it swallowed.
    it('marks each item of a range spanning list items, never the items themselves', () => {
      const html = render('- a {==one\n- two\n- three==}{#c1} b\n');
      expect(html).toContain(
        '<li>a <mark data-cm-kind="highlight" data-cm-id="c1">one</mark></li>',
      );
      expect(html).toContain('<li><mark data-cm-kind="highlight" data-cm-id="c1">two</mark></li>');
      expect(html).toContain(
        '<li><mark data-cm-kind="highlight" data-cm-id="c1">three</mark> b</li>',
      );
      expect(html).not.toContain('<mark data-cm-kind="highlight" data-cm-id="c1"><li>');
    });

    it('marks each cell of a range spanning table cells, never the cells themselves', () => {
      const html = render('| h | i |\n| --- | --- |\n| a {==x | y==}{#c1} |\n');
      expect(html).toContain('<td>a <mark data-cm-kind="highlight" data-cm-id="c1">x</mark></td>');
      expect(html).toContain('<td><mark data-cm-kind="highlight" data-cm-id="c1">y</mark></td>');
      expect(html).not.toContain('<mark data-cm-kind="highlight" data-cm-id="c1"><td>');
    });
  });

  // A selection may now span block boundaries, so one span arrives here as several runs in
  // several blocks. Each block's text is marked on its own; a block is never swallowed into a
  // <mark>, which is phrasing content — the same rule the STRUCTURAL guard applies to <li> and
  // <td>, keyed on the child because the root is not structural.
  describe('across block boundaries', () => {
    it('marks each paragraph of a range spanning paragraphs', () => {
      const html = render('Alpha {==one.\n\nBet==}{>>note<<}{#c1}a two.');
      expect(html).toContain(
        '<p>Alpha <mark data-cm-kind="highlight" data-cm-id="c1" data-cm-note="">one.</mark></p>',
      );
      expect(html).toContain(
        '<p><mark data-cm-kind="highlight" data-cm-id="c1" data-cm-note="">Bet</mark>a two.</p>',
      );
      expect(swallowedBlocks(html)).toBe(0);
    });

    it('marks the text of a block the range swallows whole, never the block itself', () => {
      const html = render('A{==aa\n\nMiddle whole\n\nCc==}{#c1}c');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">Middle whole</mark>');
      expect(swallowedBlocks(html)).toBe(0);
    });

    it('marks a heading and the paragraph after it as one thread', () => {
      const html = render('## He{==ad\n\nBod==}{#c1}y text\n');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">ad</mark></h2>');
      expect(html).toContain(
        '<p><mark data-cm-kind="highlight" data-cm-id="c1">Bod</mark>y text</p>',
      );
    });

    it('marks each paragraph of a range spanning a blockquote boundary', () => {
      const html = render('Intro {==here\n\n> quo==}{#c1}ted\n');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">here</mark>');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">quo</mark>');
      expect(swallowedBlocks(html)).toBe(0);
    });

    it('marks each cell of a range spanning table rows', () => {
      const html = render('| h |\n| --- |\n| {==a |\n| b==}{#c1} |\n');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">a</mark>');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">b</mark>');
      expect(swallowedBlocks(html)).toBe(0);
    });

    it('leaves a swallowed thematic break unmarked and unmoved', () => {
      const html = render('a{==bc\n\n---\n\nde==}{#c1}f\n');
      expect(html).toContain('<hr>');
      expect(swallowedBlocks(html)).toBe(0);
    });

    // No cut lands in a swallowed block, so nothing there is sliced and the escape that
    // would defeat the offset arithmetic inside a marked run is harmless here.
    it('marks across a block whose text is shorter than its source span', () => {
      const html = render('a{==bc\n\nx \\* y\n\nde==}{#c1}f\n');
      expect(html).toContain('x * y');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">bc</mark>');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">de</mark>');
    });

    it('keeps the whole-block mark on a fenced code block a range swallows', () => {
      const html = render('a{==bc\n\n```js\nconst a = 1;\n```\n\nde==}{#c1}f\n');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1"><pre>');
      expect(html).toContain('const a = 1;');
    });
  });

  // Every cut here is a source offset, so a value shorter than its source span (escapes,
  // character references, a continuation line's stripped indent) makes the arithmetic lie.
  // Leaving the delimiters visible is the fallback; slicing anyway rewrites the author's
  // words, which no reader would catch.
  //
  // Every case in this block names its leak count: the leak IS the fallback here. Each one
  // is a mark the reader asked for and did not get, so the badge in the header reports it —
  // see delimiterLeaks.ts. Fix the arithmetic and these fail, which is the point.
  describe('when a text node is shorter than its source span', () => {
    it('keeps the text intact on a wrapped list item continuation line', () => {
      const html = render('- one\n  two {==sel==}{#c1} three\n', { expectLeaks: 2 });
      expect(html).toContain('two');
      expect(html).toContain('sel');
      expect(html).toContain('three');
    });

    it('keeps the text intact after a backslash escape', () => {
      const html = render('a \\* b {==sel==}{#c1} c', { expectLeaks: 2 });
      expect(html).toContain('a * b');
      expect(html).toContain('sel');
      expect(html).toContain(' c');
    });

    it('keeps the text intact after a character reference', () => {
      const html = render('x &amp; y {==sel==}{#c1} z', { expectLeaks: 2 });
      expect(html).toContain('y');
      expect(html).toContain('sel');
      expect(html).toContain(' z');
    });

    it('keeps the text intact around an escaped pipe in a table cell', () => {
      const html = render('| h |\n| --- |\n| a \\| b {==sel==}{#c1} c |\n', { expectLeaks: 2 });
      expect(html).toContain('a | b');
      expect(html).toContain('sel');
      expect(html).toContain(' c');
    });
  });

  // Nesting is not a shape the tokenizer models, and the outer pair loses: the inner mark
  // renders, the outer delimiters stay in the body. Pinned as the failure it is, so a
  // later attempt at nesting has a case to move rather than a silence to fill.
  it('leaks the outer delimiters of nested marks', () => {
    const html = render('a {==outer {==inner==}{#c2} tail==}{#c1} b', { expectLeaks: 2 });
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c2">outer {==inner</mark>');
    expect(html).toContain('tail==}{#c1} b');
  });

  // A note's closer is the one delimiter a check against the HTML string cannot see —
  // rehype-stringify writes `<<}` as `&#x3C;&#x3C;}`. Both halves have to be counted, or
  // every note in this file is guarded at half strength.
  it('counts both delimiters of a note that failed to build', () => {
    const html = render('a \\* b {>>memo<<}{#c1} c', { expectLeaks: 2 });
    expect(html).toContain('{>>');
    expect(html).toContain('&#x3C;&#x3C;}');
  });

  // The exclusion that keeps a document *about* the syntax from lighting the badge also
  // blinds it to a span that never left a code span. Pinned so the hole is a decision.
  it('reports nothing for a span the author wrote inside inline code', () => {
    const html = render('a `code {==sel==}{#c1} x` b');
    expect(html).toContain('<code>code {==sel==}{#c1} x</code>');
  });

  // remark eats the backslashes, so an escaped delimiter is indistinguishable from a
  // leaked one by the time it reaches the DOM. The badge calls this a leak; a document
  // that means to write the syntax in prose has to fence it.
  it('counts an escaped delimiter written deliberately in prose', () => {
    const html = render('CriticMarkup writes \\{==x==\\} for a highlight.', { expectLeaks: 2 });
    expect(html).toContain('<p>CriticMarkup writes {==x==} for a highlight.</p>');
  });

  describe('inside inline elements', () => {
    it('renders a mark that sits wholly inside strong', () => {
      const html = render('a **{==sel==}{#c1}** b');
      expect(html).toContain(
        '<strong><mark data-cm-kind="highlight" data-cm-id="c1">sel</mark></strong>',
      );
      expect(html).not.toContain('{==');
      expect(html).not.toContain('{#c1}');
    });

    it('renders a mark that starts inside strong and ends outside it', () => {
      // Emphasis wins the parse, so the run is split across the boundary; both
      // halves still carry the id a sidebar click resolves against.
      expect(render('a **b {==sel** tail==}{#c1} c')).toContain(
        '<p>a <strong>b <mark data-cm-kind="highlight" data-cm-id="c1">sel</mark></strong>' +
          '<mark data-cm-kind="highlight" data-cm-id="c1"> tail</mark> c</p>',
      );
    });

    // Text split across a boundary is still the author's text on both sides, so two
    // marks are honest. A marker is not text — a second one would put two bubbles in
    // the body for the single thread the sidebar shows.
    it('emits one marker when a note is split by an inline boundary', () => {
      const html = render('a **b {>>note** more<<}{#c1} c');
      expect(html.match(/💬/g)).toHaveLength(1);
      expect(html).not.toContain('note');
      expect(html).not.toContain('more');
    });

    it('renders a mark inside a link', () => {
      const html = render('a [{==sel==}{#c1}](https://example.com) b');
      expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">sel</mark>');
      expect(html).not.toContain('{==');
    });

    // Delimiters inside a code span are the author's literal text, not markup.
    it('leaves delimiters inside inline code alone', () => {
      const html = render('a `{==sel==}{#c1}` b');
      expect(html).toContain('<code>{==sel==}{#c1}</code>');
      expect(html).not.toContain('<mark');
    });

    // The reason <mark> is opaque: its children were resolved when it was built, and
    // walking back in would wrap the <strong> it swallowed a second time.
    it('does not double-wrap inner markup a mark already swallowed', () => {
      const html = render('foo {==bar **bold** baz==}{#c1} tail');
      expect(html).toContain(
        '<mark data-cm-kind="highlight" data-cm-id="c1">bar <strong>bold</strong> baz</mark>',
      );
      expect(html.match(/<mark/g)).toHaveLength(1);
    });

    it('leaves delimiters inside a fenced block alone', () => {
      const html = render('- item\n\n  ```js\n  const a = {==1==};\n  ```\n');
      expect(html).toContain('const a = {==1==};');
      expect(html).not.toContain('<mark');
    });
  });
});
