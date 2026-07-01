import type { Element, ElementContent, Root, Text } from 'hast';
import type { Span } from '../rfm/types.js';

const OPENER = 3;
const RENDERED_KINDS = new Set<Span['kind']>(['highlight', 'comment', 'insertion', 'deletion']);

interface Boundary {
  start: number;
  end: number;
  span: Span;
}

function nodeOffsets(node: ElementContent): { start: number; end: number } | null {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  return s === undefined || e === undefined ? null : { start: s, end: e };
}

/** Split a text node so it never straddles any cut offset. Returns replacement nodes. */
function splitText(node: Text, cuts: number[]): Text[] {
  const off = node.position?.start.offset;
  if (off === undefined) return [node];
  const inside = cuts.filter((c) => c > off && c < off + node.value.length).sort((a, b) => a - b);
  if (inside.length === 0) return [node];
  const out: Text[] = [];
  let prev = off;
  for (const c of [...inside, off + node.value.length]) {
    const value = node.value.slice(prev - off, c - off);
    out.push({
      type: 'text',
      value,
      position: {
        start: { line: 0, column: 0, offset: prev },
        end: { line: 0, column: 0, offset: c },
      },
    });
    prev = c;
  }
  return out;
}

function mark(kind: Span['kind'], id: string | undefined, children: ElementContent[]): Element {
  return {
    type: 'element',
    tagName: 'mark',
    properties: { 'data-cm-kind': kind, ...(id !== undefined ? { 'data-cm-id': id } : {}) },
    children,
  };
}

export function rehypeCriticMarkup(spans: Span[]): (tree: Root) => void {
  const rendered = spans.filter((s) => RENDERED_KINDS.has(s.kind));
  const cuts = rendered.flatMap((s) => [
    s.start,
    s.start + OPENER,
    s.start + OPENER + s.inner.length,
    s.end,
  ]);
  const inners: Boundary[] = rendered.map((s) => ({
    start: s.start + OPENER,
    end: s.start + OPENER + s.inner.length,
    span: s,
  }));
  const delims: { start: number; end: number }[] = rendered.flatMap((s) => [
    { start: s.start, end: s.start + OPENER },
    { start: s.start + OPENER + s.inner.length, end: s.end },
  ]);

  function processChildren(children: ElementContent[]): ElementContent[] {
    // 1. split text nodes at boundaries
    const split: ElementContent[] = children.flatMap((c): ElementContent[] =>
      c.type === 'text' ? splitText(c, cuts) : [c],
    );
    // 2. drop delimiter nodes, group inner nodes into marks
    const out: ElementContent[] = [];
    let i = 0;
    while (i < split.length) {
      const node = split[i];
      if (node === undefined) {
        i += 1;
        continue;
      }
      const o = nodeOffsets(node);
      const delim = o !== null && delims.some((d) => o.start >= d.start && o.end <= d.end);
      if (delim) {
        i += 1;
        continue;
      }
      const inner =
        o !== null ? inners.find((b) => o.start >= b.start && o.end <= b.end) : undefined;
      if (inner === undefined) {
        out.push(node);
        i += 1;
        continue;
      }
      const run: ElementContent[] = [];
      while (i < split.length) {
        const n = split[i];
        if (n === undefined) break;
        const no = nodeOffsets(n);
        if (no === null || !(no.start >= inner.start && no.end <= inner.end)) break;
        run.push(n);
        i += 1;
      }
      if (run.length > 0) out.push(mark(inner.span.kind, inner.span.id, run));
    }
    return out;
  }

  // Block-level containers whose direct children form a phrasing line we process.
  // We recurse ONLY into these — never into inline elements (strong/em/code/a/mark),
  // otherwise a strong wrapped into a mark would have its inner text re-wrapped
  // (double-wrap bug). CriticMarkup delimiters live at the block's phrasing level
  // by v1.1 scope, so skipping inline elements is correct.
  const BLOCK = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'td',
    'th',
    'blockquote',
    'dd',
    'dt',
    'div',
    'section',
    'article',
  ]);

  function walk(node: Root | Element): void {
    node.children = processChildren(node.children as ElementContent[]);
    for (const child of node.children) {
      if (child.type === 'element' && BLOCK.has(child.tagName)) walk(child);
    }
  }

  return (tree: Root): void => {
    walk(tree);
  };
}
