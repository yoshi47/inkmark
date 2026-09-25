import type { Element, Root } from 'hast';
import { SKIP, visit } from 'unist-util-visit';

const NUMBERED = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'pre', 'table']);

/**
 * Stamp each block with the source line it starts on, for the line-number gutter (theme.css draws
 * it from `data-line`). Not `data-src-start`: `annotatedAncestor` resolves selections to the
 * nearest ancestor carrying that, and a gutter must not change what a drag anchors to.
 */
export function rehypeLineNumbers(): (tree: Root) => void {
  return (tree: Root): void => {
    // Only nesting puts two blocks on one line (a loose item's <p>, a fence opening an item), so
    // the outermost keeps the number and the ones inside it would only stack on top of it.
    const stamped = new Set<number>();
    visit(tree, 'element', (node: Element) => {
      // github-markdown-css positions footnote items, which would pull the number over their text.
      // Their lines sit at the end of the file anyway, far from where the footnote is read.
      if (node.properties['dataFootnotes'] !== undefined) return SKIP;
      if (!NUMBERED.has(node.tagName)) return undefined;
      const line = node.position?.start.line;
      if (line === undefined || stamped.has(line)) return undefined;
      stamped.add(line);
      node.properties['dataLine'] = line;
      return undefined;
    });
  };
}
