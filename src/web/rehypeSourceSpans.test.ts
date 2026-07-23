import type { Element, Root } from 'hast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../rfm/tokenize.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';
import { rehypeSourceSpans } from './rehypeSourceSpans.js';

/** The hast tree, not its serialization: `data-src-atomic` stringifies differently per renderer
 *  (bare attribute via rehype-stringify, "true" via React), so assert the property itself. */
function spans(src: string): Element[] {
  const proc = remark().use(remarkGfm).use(remarkRehype).use(rehypeSourceSpans);
  const tree: Root = proc.runSync(proc.parse(src), src);
  const out: Element[] = [];
  visit(tree, 'element', (node: Element) => {
    if (node.tagName === 'span') out.push(node);
  });
  return out;
}

describe('rehypeSourceSpans', () => {
  it('flags inline-code runs as atomic and leaves plain runs unflagged', () => {
    const [lead, code, tail] = spans('see `.zshrc` here');
    expect(lead?.properties).toEqual({ dataSrcStart: 0, dataSrcEnd: 4 });
    expect(code?.properties).toEqual({ dataSrcStart: 4, dataSrcEnd: 12, dataSrcAtomic: true });
    expect(tail?.properties).toEqual({ dataSrcStart: 12, dataSrcEnd: 17 });
  });

  it('emits no span for a fenced code block', () => {
    expect(spans('```sh\necho hi\n```\n')).toEqual([]);
  });

  it('keeps source offsets on a code run wrapped into a mark', () => {
    // Runs inside a mark keep the offsets the overlap check needs; losing them would turn the
    // "already commented" refusal into no popover at all.
    const src = 'x {==`m`==} y';
    const proc = remark()
      .use(remarkGfm)
      .use(remarkRehype)
      .use(() => rehypeCriticMarkup(tokenize(src)))
      .use(rehypeSourceSpans);
    const tree: Root = proc.runSync(proc.parse(src), src);
    const marked: Element[] = [];
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'span' && node.properties['dataSrcAtomic'] === true) marked.push(node);
    });
    expect(marked[0]?.properties).toEqual({
      dataSrcStart: 5,
      dataSrcEnd: 8,
      dataSrcAtomic: true,
    });
  });
});
