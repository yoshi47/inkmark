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
function elements(src: string, tagName: string): Element[] {
  const proc = remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rehypeSourceSpans(src));
  const tree: Root = proc.runSync(proc.parse(src), src);
  const out: Element[] = [];
  visit(tree, 'element', (node: Element) => {
    if (node.tagName === tagName) out.push(node);
  });
  return out;
}

function spans(src: string): Element[] {
  return elements(src, 'span');
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

  it('annotates a top-level fenced code block on its <pre>', () => {
    const src = 'intro\n\n```js\nconst a = 1;\n```\n';
    expect(elements(src, 'pre')[0]?.properties).toEqual({
      dataSrcStart: 7,
      dataSrcEnd: 29,
      dataSrcBlock: true,
    });
  });

  it('flags the fence shapes a block mark can still wrap', () => {
    const shapes = [
      '~~~js\na\n~~~\n', // tilde fence
      '```\na\n```\n', // no language
      '````js\na\n````\n', // four backticks
      '```js\na\n   ```\n', // closer indented up to three spaces
      '```js\na\n`````\n', // closer longer than the opener
    ];
    for (const src of shapes) {
      expect(elements(src, 'pre')[0]?.properties['dataSrcBlock']).toBe(true);
    }
  });

  it('leaves a code block unflagged when a mark written round it would not survive', () => {
    // Each shape looks wrappable by one half of the test alone: an indented block starts at column
    // 1 (its position includes the four spaces); a nested fence and a quoted one open with
    // backticks; an unterminated fence — or one whose closer is too short — has no line after the
    // code for the closing delimiter, which would land inside the code instead.
    const unmarkable = [
      'intro\n\n    code\n', // indented block
      '- x\n\n  ```js\n  a\n  ```\n', // nested in a list
      '> ```\n> q\n> ```\n', // nested in a quote
      'intro\n\n```js\nconst a = 1;\n', // never terminated
      'intro\n\n````js\na\n```\nb\n', // closer shorter than the opener
    ];
    const flags = unmarkable.map((src) => {
      const props = elements(src, 'pre')[0]?.properties;
      // The offsets stay: without them the selection resolves to nothing at all rather than to a
      // refusal the popover can explain.
      expect(props?.['dataSrcStart']).toEqual(expect.any(Number));
      return props?.['dataSrcBlock'];
    });
    expect(flags).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('keeps source offsets on a code run wrapped into a mark', () => {
    // Runs inside a mark keep the offsets the overlap check needs; losing them would turn the
    // "already commented" refusal into no popover at all.
    const src = 'x {==`m`==} y';
    const proc = remark()
      .use(remarkGfm)
      .use(remarkRehype)
      .use(() => rehypeCriticMarkup(tokenize(src)))
      .use(() => rehypeSourceSpans(src));
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
