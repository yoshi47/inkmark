import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../rfm/tokenize.js';
import { MarkdownView } from './MarkdownView.js';

function renderSource(src: string): HTMLElement {
  return render(<MarkdownView source={src} spans={tokenize(src)} />).container;
}

describe('MarkdownView images', () => {
  it('points a document-relative image at the asset endpoint', () => {
    const img = renderSource('![a](../99_ASSETS/2026/09/a.png)\n').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/asset?path=..%2F99_ASSETS%2F2026%2F09%2Fa.png');
  });

  it('round-trips a non-ASCII filename', () => {
    const img = renderSource('![a](./画像.png)\n').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/asset?path=.%2F%E7%94%BB%E5%83%8F.png');
  });

  it('round-trips a filename with a space', () => {
    const img = renderSource('![a](<./my shot.png>)\n').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/asset?path=.%2Fmy%20shot.png');
  });

  it('leaves a remote image alone', () => {
    const img = renderSource('![a](https://x/y.png)\n').querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://x/y.png');
  });

  it('rewrites an image inside a mark, which the rehype plugins rebuild', () => {
    const img = renderSource('{==![a](./z.png)==}{#c1}\n').querySelector('mark img');
    expect(img?.getAttribute('src')).toBe('/api/asset?path=.%2Fz.png');
  });

  it('rewrites a reference-style image', () => {
    const img = renderSource('![a][ref]\n\n[ref]: ./z.png\n').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/asset?path=.%2Fz.png');
  });

  it('leaves a relative link alone', () => {
    const link = renderSource('[a](./other.md)\n').querySelector('a');
    expect(link?.getAttribute('href')).toBe('./other.md');
  });
});

describe('MarkdownView line numbers', () => {
  function lines(src: string): [string, string | undefined][] {
    return [...renderSource(src).querySelectorAll<HTMLElement>('[data-line]')].map((el) => [
      el.tagName.toLowerCase(),
      el.dataset['line'],
    ]);
  }

  it('stamps each block with the source line it starts on', () => {
    expect(lines('# T\n\npara\n\n- a\n- b\n\n```\nx\n```\n\n| h |\n|---|\n| c |\n')).toEqual([
      ['h1', '1'],
      ['p', '3'],
      ['li', '5'],
      ['li', '6'],
      ['pre', '8'],
      ['table', '12'],
    ]);
  });

  it('numbers a loose list item once, not again on its paragraph', () => {
    expect(lines('- a\n\n- b\n')).toEqual([
      ['li', '1'],
      ['li', '3'],
    ]);
  });

  it('numbers a fence that opens a list item once', () => {
    expect(lines('- ```\n  x\n  ```\n')).toEqual([['li', '1']]);
  });

  it('leaves footnote definitions unnumbered', () => {
    expect(lines('a[^1]\n\n[^1]: note\n')).toEqual([['p', '1']]);
  });

  it('keeps the line of a paragraph that carries a comment mark', () => {
    expect(lines('x\n\nsee {==this==}{>>why<<}{#c1} here\n')).toEqual([
      ['p', '1'],
      ['p', '3'],
    ]);
  });
});
