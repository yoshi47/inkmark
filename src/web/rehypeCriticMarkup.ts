import type { Element, ElementContent, Root, Text } from 'hast';
import type { Span } from '../rfm/types.js';

const OPENER = 3;
const RENDERED_KINDS = new Set<Span['kind']>(['highlight', 'comment', 'insertion', 'deletion']);
/** What a note leaves in the body once its text moves to the sidebar. */
const MARKER: Text = { type: 'text', value: '💬' };

interface Boundary {
  start: number;
  end: number;
  kind: Span['kind'];
  id: string | undefined;
  note: boolean;
  anchor: boolean;
}

/**
 * Each highlight paired with the note written right after it — the pair the
 * sidebar treats as one thread has to render as one mark, or a click lands on
 * a thread the body never showed.
 *
 * Wider than `noteFor`'s adjacency test (src/rfm/parse.ts), which pairs only an
 * *id-less* trailing note: the shape `insertComment` writes puts the id on the
 * note instead, and `noteFor` resolves that one through its own-span branch.
 * Both have to fold into the highlight.
 *
 * Ids are what makes folding safe. Two of them is two marks an agent wrote, not
 * a pair; none of them is a note no sidebar thread can speak for, and hiding it
 * would leave its text nowhere in the app at all.
 */
function pairNotes(spans: Span[]): Map<Span, Span> {
  const notes = new Map<Span, Span>();
  for (const [i, span] of spans.entries()) {
    if (span.kind !== 'highlight') continue;
    const next = spans[i + 1];
    if (next?.kind !== 'comment' || next.start !== span.end) continue;
    if ((span.id === undefined) === (next.id === undefined)) continue;
    notes.set(span, next);
  }
  return notes;
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

function mark(b: Boundary, children: ElementContent[]): Element {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      'data-cm-kind': b.kind,
      ...(b.id !== undefined ? { 'data-cm-id': b.id } : {}),
      ...(b.note ? { 'data-cm-note': '' } : {}),
    },
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
  const notes = pairNotes(spans);
  const paired = new Set(notes.values());
  const inners: Boundary[] = rendered
    .filter((s) => !paired.has(s))
    .map((s) => ({
      start: s.start + OPENER,
      end: s.start + OPENER + s.inner.length,
      kind: s.kind,
      id: s.id ?? notes.get(s)?.id,
      note: notes.has(s),
      // A note with no highlight to hand itself to trades its text for a
      // marker, so its thread still has a place in the body to scroll to. An
      // id-less one keeps its text: nothing in the sidebar can speak for it.
      anchor: s.kind === 'comment' && s.id !== undefined,
    }));
  const delims: { start: number; end: number }[] = rendered.flatMap((s) =>
    paired.has(s)
      ? [{ start: s.start, end: s.end }]
      : [
          { start: s.start, end: s.start + OPENER },
          { start: s.start + OPENER + s.inner.length, end: s.end },
        ],
  );

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
      // The marker is a real child, not a ::before: it has to survive copied
      // text and a stylesheet that failed to load.
      if (run.length > 0) out.push(mark(inner, inner.anchor ? [MARKER] : run));
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
