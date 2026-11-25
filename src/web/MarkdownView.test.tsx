import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../rfm/tokenize.js';
import { MarkdownView } from './MarkdownView.js';
import { collectHeadings } from './toc.js';

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

describe('MarkdownView frontmatter', () => {
  const DOC = '---\ncreated: 2026-11-25\n---\n\n# Title\n\nBody.\n';

  it('shows frontmatter as a metadata block, not as a rule and a heading', () => {
    const root = renderSource(DOC);
    expect(root.querySelector('hr')).toBeNull();
    expect([...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => h.textContent)).toEqual([
      'Title',
    ]);
    const meta = root.querySelector('details.frontmatter');
    expect(meta?.querySelector('pre')?.textContent).toBe('created: 2026-11-25');
  });

  it('keeps the frontmatter out of the table of contents', () => {
    expect(collectHeadings(renderSource(DOC)).map((e) => e.text)).toEqual(['Title']);
  });

  it('keeps line numbers and source offsets pointing into the file as saved', () => {
    const root = renderSource(DOC);
    expect(
      [...root.querySelectorAll<HTMLElement>('[data-line]')].map((el) => [
        el.tagName.toLowerCase(),
        el.dataset['line'],
      ]),
    ).toEqual([
      ['details', '1'],
      ['h1', '5'],
      ['p', '7'],
    ]);
    const run = root.querySelector<HTMLElement>('p [data-src-start]');
    expect(run?.dataset['srcStart']).toBe(String(DOC.indexOf('Body.')));
    expect(root.querySelector('h1')?.id).toBe(`h-${String(DOC.indexOf('# Title'))}`);
  });

  it('gives the metadata block no source offsets, so nothing can be marked inside it', () => {
    expect(renderSource(DOC).querySelector('.frontmatter [data-src-start]')).toBeNull();
  });

  it('leaves a later --- as a rule and a setext heading as before', () => {
    const root = renderSource('# T\n\n---\n\nkey: value\n---\n');
    expect(root.querySelector('.frontmatter')).toBeNull();
    expect(root.querySelector('hr')).not.toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe('key: value');
  });

  it('does not let an unterminated opening --- swallow the document', () => {
    const root = renderSource('---\n# Title\n\ntext\n');
    expect(root.querySelector('.frontmatter')).toBeNull();
    expect(root.querySelector('hr')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('p')?.textContent).toBe('text');
  });

  it('keeps a document that opens with a rule as rules and prose', () => {
    const root = renderSource('---\n\nIntro para.\n\n---\n\n# H\n');
    expect(root.querySelector('.frontmatter')).toBeNull();
    expect([...root.querySelectorAll('hr, p, h1')].map((el) => el.tagName.toLowerCase())).toEqual([
      'hr',
      'p',
      'hr',
      'h1',
    ]);
    expect(root.querySelector('p')?.textContent).toBe('Intro para.');
  });

  it('keeps a heading between two rules as before', () => {
    const root = renderSource('---\n# Title\n---');
    expect(root.querySelector('.frontmatter')).toBeNull();
    expect(root.querySelectorAll('hr')).toHaveLength(2);
    expect(root.querySelector('h1')?.textContent).toBe('Title');
  });

  it('renders text right after the closing fence as a paragraph on its own line', () => {
    const p = renderSource('---\na: 1\n---\ntext\n').querySelector<HTMLElement>('p');
    expect(p?.textContent).toBe('text');
    expect(p?.dataset['line']).toBe('4');
  });

  it('recognises frontmatter behind a byte order mark without shifting offsets', () => {
    const src = '\uFEFF---\na: 1\n---\n\nBody.\n';
    const root = renderSource(src);
    expect(root.querySelector('.frontmatter pre')?.textContent).toBe('a: 1');
    expect(root.querySelector<HTMLElement>('p [data-src-start]')?.dataset['srcStart']).toBe(
      String(src.indexOf('Body.')),
    );
  });
});
