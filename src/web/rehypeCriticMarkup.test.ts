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

  it('renders adjacent highlight + comment as two marks', () => {
    const html = render('x {==sel==}{>>note<<}{#c1} y');
    expect(html).toContain('<mark data-cm-kind="highlight">sel</mark>');
    expect(html).toContain('<mark data-cm-kind="comment" data-cm-id="c1">note</mark>');
    expect(html).not.toContain('{>>');
    expect(html).not.toContain('<<}');
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

  it('handles a second mark elsewhere in an already-marked paragraph', () => {
    const html = render('one {==first==}{#c1} two {==second==}{#c2} three');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">first</mark>');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c2">second</mark>');
  });
});
