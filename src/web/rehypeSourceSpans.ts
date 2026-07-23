import type { Element, Root, Text } from 'hast';
import { visit } from 'unist-util-visit';

/** Wrap each source text node in a <span> carrying its body offset range. */
export function rehypeSourceSpans(): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const pos = node.position;
      const startOff = pos?.start.offset;
      const endOff = pos?.end.offset;
      if (startOff === undefined || endOff === undefined) return; // synthetic (e.g. mark children)
      // inlineCode's text node inherits the inlineCode position, which INCLUDES the backtick
      // delimiters ⇒ source != rendered text for this run. Flag it so selection resolution can
      // snap endpoints to the run's source boundaries instead of refusing them.
      const atomic = parent.type === 'element' && parent.tagName === 'code';
      const span: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          dataSrcStart: startOff,
          dataSrcEnd: endOff,
          ...(atomic ? { dataSrcAtomic: true } : {}),
        },
        children: [node],
      };
      (parent.children as unknown as (Element | Text)[])[index] = span;
    });
  };
}
