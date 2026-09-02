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
