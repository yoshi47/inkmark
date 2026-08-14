import { describe, expect, it } from 'vitest';
import { leakedDelimiters, leakedDelimitersIn } from './delimiterLeaks.js';

function el(html: string): HTMLElement {
  const node = document.createElement('div');
  node.innerHTML = html;
  return node;
}

describe('leakedDelimiters', () => {
  it('finds nothing in text that carries no delimiters', () => {
    expect(leakedDelimiters('a perfectly ordinary paragraph')).toEqual([]);
  });

  it('reports each delimiter with the words around it', () => {
    const [first] = leakedDelimiters('the quick brown fox {== jumps over the lazy dog');
    expect(first).toContain('{==');
    expect(first).toContain('brown fox');
    expect(first).toContain('jumps over');
  });

  it('reports an opener and its closer separately', () => {
    expect(leakedDelimiters('a {== b ==} c')).toHaveLength(2);
  });

  it('reports a closer left on its own', () => {
    expect(leakedDelimiters('d ==} e')).toEqual(['d ==} e']);
  });

  it('collapses whitespace so a wrapped line still reads as one snippet', () => {
    expect(leakedDelimiters('one\n  two {== three')).toEqual(['one two {== three']);
  });

  it('ignores an id marker with no delimiter beside it', () => {
    expect(leakedDelimiters('see {#c1} for details')).toEqual([]);
  });

  it('covers every rendered kind', () => {
    expect(leakedDelimiters('{== ==} {>> <<} {++ ++} {-- --} {~~ ~~}')).toHaveLength(10);
  });
});

describe('leakedDelimitersIn', () => {
  it('finds nothing in a document that rendered cleanly', () => {
    expect(leakedDelimitersIn(el('<p>a <mark>b</mark> c</p>'))).toEqual([]);
  });

  it('reports a delimiter left in the prose', () => {
    expect(leakedDelimitersIn(el('<p>a {==b==} c</p>'))).toHaveLength(2);
  });

  it('spares delimiters the author typed in code', () => {
    expect(leakedDelimitersIn(el('<p>write <code>{==x==}</code> to highlight</p>'))).toEqual([]);
  });

  it('spares delimiters inside a fenced block', () => {
    expect(leakedDelimitersIn(el('<pre><code>{==x==}</code></pre>'))).toEqual([]);
  });

  it('counts a leak in the prose while sparing the one in code beside it', () => {
    expect(leakedDelimitersIn(el('<p>{== and <code>{==</code></p>'))).toHaveLength(1);
  });

  it('sees a closer in the text node an element boundary left it in', () => {
    expect(leakedDelimitersIn(el('<p><mark>b </mark><code>x</code> c==} d</p>'))).toHaveLength(1);
  });

  it('invents no delimiter from the text on either side of a code span', () => {
    expect(leakedDelimitersIn(el('<p>a {<code>x</code>== y</p>'))).toEqual([]);
  });

  it('misses a delimiter markup split down the middle', () => {
    expect(leakedDelimitersIn(el('<p>a {<em>==</em> y</p>'))).toEqual([]);
  });
});
