import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Give every heading an `id` so the table of contents has something to jump to. The value comes
 * from the heading's source offset, which two headings can never share — a slug would need a
 * dedup suffix, and the suffix would move whenever an earlier duplicate was renamed.
 *
 * Deliberately NOT `data-src-start`, the attribute `rehypeSourceSpans` writes: `annotatedAncestor`
 * (sourceOffset.ts) resolves a selection to the nearest ancestor carrying it. Heading text has a
 * span of its own and stops there, but an endpoint with no span — the synthetic 💬 inside a mark,
 * or a range anchored on the element itself — would climb to the heading and resolve to its whole
 * source range, delimiters included. The table of contents has no business changing what a drag
 * over the document anchors to.
 */
export function rehypeHeadingIds(): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (!HEADINGS.has(node.tagName)) return;
      // Nothing in the pipeline synthesizes a heading today, but were one to appear it would get
      // no id rather than a counter-based one: an id not derived from the source moves whenever
      // the headings before it change, and the jump would land somewhere the reader never chose.
      const offset = node.position?.start.offset;
      if (offset === undefined) return;
      if (node.properties['id'] !== undefined) return;
      node.properties['id'] = `h-${String(offset)}`;
    });
  };
}
