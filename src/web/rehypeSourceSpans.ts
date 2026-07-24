import type { Element, Root, Text } from 'hast';
import { visit } from 'unist-util-visit';
import { isFencedBlock } from '../rfm/fence.js';

/**
 * Wrap each source text node in a <span> carrying its body offset range, and annotate each code
 * block on its <pre>. `body` is the source those offsets index into: which blocks a mark can wrap
 * is decided from the source, and `isFencedBlock` is the same test the writer applies, so the two
 * cannot drift into offering a block the writer would then mangle.
 */
export function rehypeSourceSpans(body: string): (tree: Root) => void {
  return (tree: Root): void => {
    // A code block's text node carries no position of its own, so the block is annotated on its
    // <pre> — the element whose position IS the block. The offsets go on every block, markable or
    // not: without them `annotatedAncestor` climbs straight past the <pre>, and a selection there
    // resolves to null, which shows no popover at all rather than a refusal with a reason.
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'pre') return;
      const startOff = node.position?.start.offset;
      const endOff = node.position?.end.offset;
      if (startOff === undefined || endOff === undefined) return;
      node.properties['dataSrcStart'] = startOff;
      node.properties['dataSrcEnd'] = endOff;
      if (isFencedBlock(body, startOff, endOff)) node.properties['dataSrcBlock'] = true;
    });
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
