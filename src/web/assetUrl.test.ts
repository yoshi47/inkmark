import type { Element } from 'hast';
import { defaultUrlTransform } from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { assetUrlTransform } from './assetUrl.js';

function el(tagName: string): Element {
  return { type: 'element', tagName, properties: {}, children: [] };
}

const img = el('img');
const a = el('a');

describe('assetUrlTransform', () => {
  it('routes a document-relative image path through the asset endpoint', () => {
    expect(assetUrlTransform('./img/z.png', 'src', img)).toBe('/api/asset?path=.%2Fimg%2Fz.png');
  });

  it('keeps a path that climbs above the document directory', () => {
    expect(assetUrlTransform('../99_ASSETS/2026/09/a.png', 'src', img)).toBe(
      '/api/asset?path=..%2F99_ASSETS%2F2026%2F09%2Fa.png',
    );
  });

  it('leaves an absolute http(s) image alone', () => {
    expect(assetUrlTransform('https://x/y.png', 'src', img)).toBe('https://x/y.png');
  });

  it('leaves a protocol-relative image alone', () => {
    expect(assetUrlTransform('//x/y.png', 'src', img)).toBe('//x/y.png');
  });

  it('still strips an unsafe protocol', () => {
    for (const url of ['data:image/png;base64,AAA', 'javascript:alert(1)']) {
      const out = assetUrlTransform(url, 'src', img);
      expect(out).not.toMatch(/^\/api\/asset/);
      expect(out).toBe(defaultUrlTransform(url));
    }
  });

  // The module reimplements react-markdown's colon test to decide what a protocol is; if the two
  // ever disagree, a URL this module treats as a path would have been sanitized upstream.
  it('agrees with react-markdown on every URL it does not rewrite', () => {
    for (const url of [
      '',
      '#a',
      '//x/y.png',
      'https://x/y.png',
      'mailto:a@b',
      'foo:bar',
      'a:b/c',
    ]) {
      expect(assetUrlTransform(url, 'src', img)).toBe(defaultUrlTransform(url));
    }
  });

  it('leaves a link href untouched', () => {
    expect(assetUrlTransform('./other.md', 'href', a)).toBe('./other.md');
  });

  it('leaves a src on an element that is not an image untouched', () => {
    expect(assetUrlTransform('./clip.mp4', 'src', el('video'))).toBe('./clip.mp4');
  });

  it('leaves a fragment untouched', () => {
    expect(assetUrlTransform('#section', 'src', img)).toBe('#section');
  });
});
