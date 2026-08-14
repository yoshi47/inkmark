import type { Element, Root } from 'hast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';
import { rehypeHeadingIds } from './rehypeHeadingIds.js';

function elements(src: string, tagNames: string[]): Element[] {
  const proc = remark().use(remarkGfm).use(remarkRehype).use(rehypeHeadingIds);
  const tree: Root = proc.runSync(proc.parse(src), src);
  const out: Element[] = [];
  visit(tree, 'element', (node: Element) => {
    if (tagNames.includes(node.tagName)) out.push(node);
  });
  return out;
}

function ids(src: string): unknown[] {
  return elements(src, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']).map((el) => el.properties['id']);
}

describe('rehypeHeadingIds', () => {
  it('gives every heading level an id', () => {
    expect(ids('# A\n\n## B\n\n###### F\n')).toEqual(['h-0', 'h-5', 'h-11']);
  });

  it('gives two headings of the same text different ids', () => {
    // The whole reason for offsets over slugs: a slug would need a dedup suffix here.
    expect(new Set(ids('## Usage\n\n## Usage\n')).size).toBe(2);
  });

  it('gives a setext heading an id too', () => {
    expect(ids('Title\n=====\n')).toEqual(['h-0']);
  });

  it('gives a heading inside a list item an id', () => {
    expect(ids('- # Nested\n')).toEqual(['h-2']);
  });

  it('leaves non-headings alone', () => {
    const src = '# A\n\ntext\n\n```js\ncode\n```\n';
    for (const el of elements(src, ['p', 'pre', 'code'])) {
      expect(el.properties['id']).toBeUndefined();
    }
  });
});
