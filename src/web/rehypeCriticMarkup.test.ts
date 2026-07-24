import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../rfm/tokenize.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';

function render(src: string): string {
  return remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rehypeCriticMarkup(tokenize(src)))
    .use(rehypeStringify)
    .processSync(src)
    .toString();
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
});
