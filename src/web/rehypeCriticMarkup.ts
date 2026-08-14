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
  const o = nodeOffsets(node);
  if (o === null) return [node];
  const inside = cuts.filter((c) => c > o.start && c < o.end).sort((a, b) => a - b);
  if (inside.length === 0) return [node];
  // The cuts are source offsets, so slicing the value by them holds only while the two
  // run in step. A backslash escape, a character reference or a continuation line's
  // stripped indent makes the value SHORTER than its source span, and every cut past
  // that point then lands one or more characters early — the author's words come out as
  // different words, with nothing to see. Leaving the node whole leaks the delimiters as
  // visible text instead: wrong in a way a reader can act on.
  //
  // Longer is not the same problem, so it is not refused. remark-rehype appends to a
  // text node (the space before a footnote's backref) rather than growing it in place,
  // which leaves every offset before the extra where it was.
  if (node.value.length < o.end - o.start) return [node];
  const off = o.start;
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

  // An anchored note trades its text for one marker. A range an element boundary cuts in
  // two arrives here as two runs, and a second marker would put two bubbles in the body
  // for the one thread the sidebar shows. Which run keeps it is processing order, not
  // document order — only a document whose delimiters cross an emphasis boundary can
  // tell the difference, and there the delimiters are already malformed.
  const anchored = new Set<Boundary>();

  function processChildren(children: ElementContent[], parent: string): ElementContent[] {
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
      // Under a container whose content model names its children, a run would group a whole
      // <li> or <td> and nest the <mark> straight under <ul>/<tr>. That is invalid: the list
      // stops counting the item, <mark> is inline so the highlight paints on nothing, and any
      // re-parse (a copy, innerHTML, a future SSR path) foster-parents the mark out of the
      // table with the cell inside it. The recursion into each child still marks the text
      // there, so a mark spanning several items renders as one per item.
      const inner =
        o !== null && !STRUCTURAL.has(parent)
          ? inners.find((b) => o.start >= b.start && o.end <= b.end)
          : undefined;
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
      if (inner.anchor) {
        if (!anchored.has(inner)) {
          anchored.add(inner);
          out.push(mark(inner, [MARKER]));
        }
      } else if (run.length > 0) {
        out.push(mark(inner, run));
      }
    }
    return out;
  }

  // Elements we never descend into. A denylist rather than a list of blocks to
  // visit: an allowlist has to name every structural wrapper too (ul/ol/table/
  // tbody/tr), and a wrapper it forgets takes its whole subtree with it — naming li
  // and td buys nothing while ol and tr are the ones standing in the way.
  //
  // - mark: ours, already built. Its children are inside a span we resolved, and
  //   re-running them would wrap a swallowed <strong> a second time.
  // - code/pre: delimiters typed in code are the author's literal text. `code`
  //   also carries its backticks inside its own text node's offsets, so the split
  //   step in processChildren would cut in the wrong places.
  const OPAQUE = new Set(['mark', 'code', 'pre']);

  // Containers whose content model names exactly which children they may hold. Their
  // children are never grouped into a mark — see the run-collection guard above.
  const STRUCTURAL = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl']);

  // A block wrapped on lines of its own (the only anchor a fenced code block has) leaves its
  // closing delimiters as a paragraph of their own, and dropping that paragraph's text leaves an
  // empty <p> the document never had. Emptied, not empty: a block that came in with no children
  // is the author's and stays. Paragraphs only, though a delimiter line could in principle empty
  // any block — a vanished <td> or <li> shifts a whole table or list, which is a worse way to be
  // wrong than an empty one.
  function walk(node: Root | Element): void {
    // The root is not structural: a mark wrapping whole top-level blocks is how a fenced
    // code block gets marked at all.
    const tag = node.type === 'element' ? node.tagName : '';
    node.children = processChildren(node.children as ElementContent[], tag);
    const emptied = new Set<Element>();
    for (const child of node.children) {
      if (child.type !== 'element' || OPAQUE.has(child.tagName)) continue;
      const had = child.children.length > 0;
      walk(child);
      if (had && child.children.length === 0 && child.tagName === 'p') emptied.add(child);
    }
    if (emptied.size > 0) {
      node.children = node.children.filter((c) => c.type !== 'element' || !emptied.has(c));
    }
  }

  return (tree: Root): void => {
    walk(tree);
  };
}
