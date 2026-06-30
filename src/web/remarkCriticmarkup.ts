import type { PhrasingContent, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';
import { tokenize } from '../rfm/tokenize.js';

export function remarkCriticmarkup(): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const spans = tokenize(node.value);
      if (spans.length === 0) return;

      const out: PhrasingContent[] = [];
      let cursor = 0;
      for (const span of spans) {
        if (span.kind === 'substitution') continue; // collides with GFM ~~; not rendered in v1
        if (span.start > cursor) {
          out.push({ type: 'text', value: node.value.slice(cursor, span.start) });
        }
        const display = span.inner;
        // Emit a node whose hast form is <mark ...>display</mark>.
        // hChildren preserves the inner text (a bare hName on a text node would drop the value).
        out.push({
          type: 'text',
          value: display,
          data: {
            hName: 'mark',
            hProperties: {
              'data-cm-kind': span.kind,
              ...(span.id !== undefined ? { 'data-cm-id': span.id } : {}),
            },
            hChildren: [{ type: 'text', value: display }],
          },
        } as unknown as PhrasingContent);
        cursor = span.end;
      }
      if (cursor < node.value.length) {
        out.push({ type: 'text', value: node.value.slice(cursor) });
      }
      if (out.length === 0) return;
      (parent.children as unknown as PhrasingContent[]).splice(index, 1, ...out);
      return index + out.length;
    });
  };
}
