# Selection-comment across inline formatting & marks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select text that spans inline formatting (bold/italic/code/links) and/or sits in an already-marked paragraph, and successfully attach a comment — while the resulting CriticMarkup highlight still renders correctly (inner markdown intact, no literal `{==…==}` leaking into the view).

**Architecture:** Replace the current `remarkCriticmarkup` transform (which runs per-text-node *after* markdown inline parsing, so it can neither compose with `**bold**` nor keep source offsets on split text) with an **offset-driven rehype pass** (`rehypeCriticMarkup`). We parse markdown normally (positions preserved into hast), then use our existing, tested `tokenize(body)` offsets to (a) delete CriticMarkup delimiter characters and (b) wrap each mark's inner content — which may already contain `<strong>`/`<code>`/`<a>` nodes — in `<mark data-cm-*>`. Because every rendered text node keeps its real source offset, `resolveSelectionRange` can then map a multi-run DOM selection to a `[start,end)` source range. Selections are scoped to a single block and refused when they overlap an existing mark (which would create malformed nested CriticMarkup).

**Tech Stack:** TypeScript (strict), React + react-markdown, remark-gfm, hast / unist-util-visit, vitest + jsdom. No new runtime dependencies.

## Global Constraints

- Node `>=24`; the repo's strict eslint + `tsc -b` gates must stay green (see `memory/v1-implementation-notes.md` for the recurring adaptation patterns — `.js` import extensions, explicit return types, `strict-boolean-expressions`, `no-non-null-assertion` even in tests, `consistent-type-imports`, `noUncheckedIndexedAccess`, etc.).
- No new runtime dependencies. Reuse `src/rfm/tokenize.ts` (`tokenize(body) => Span[]`) and `src/rfm/types.ts` (`Span`).
- Pure `src/rfm` core stays framework-free; all DOM/hast code lives under `src/web`.
- Every task ends green: `pnpm lint && pnpm typecheck && pnpm test`.
- Commit after each task.

## Background — verified facts (do not re-derive)

`tokenize(body)` returns `Span[]` (`src/rfm/types.ts:3-11`): `{ kind, start, end, inner, id?, oldText?, newText? }`. Empirically confirmed on 2026-07-01:

- `"This is a {==local-first==}{>>What?<<}{#c1} viewer."` →
  - `{kind:'highlight', start:10, end:27, inner:'local-first'}`  (slice `{==local-first==}`)
  - `{kind:'comment',   start:27, end:43, inner:'What?', id:'c1'}` (slice `{>>What?<<}{#c1}`)
- `"An AI can {++add text++}{#s1} or mark {--for deletion--}{#s2}."` → one `insertion` (10-29, id s1) and one `deletion` (38-61, id s2); each `end` includes its trailing `{#sN}`.
- `"foo {==bar **bold** baz==}{#c9} tail"` → one `highlight` (4-31, inner `bar **bold** baz`, id `c9`); `end` includes `{#c9}`.
- `"a {~~old~>new~~}{#s5} b"` → one `substitution` (2-21, inner `old~>new`, id s5, oldText `old`, newText `new`).

Invariants used throughout this plan:
- **Opener is always 3 chars** (`{==` `{>>` `{++` `{--` `{~~`). So `innerStart = span.start + 3` and `innerEnd = innerStart + span.inner.length`. Characters `[span.start, innerStart)` are the opener; `[innerEnd, span.end)` are the closer plus any trailing `{#id}` (for `comment`, the closer region is `<<}{#id}`).
- A highlight and its comment are **two adjacent spans** (`highlight.end === comment.start`). The comment span renders its own inner ("What?") as a visible mark — this is existing v1 behavior and must be preserved.
- `inner` is the verbatim source substring `body.slice(innerStart, innerEnd)`.

Current failure (`src/web/sourceOffset.ts:24`): `resolveSelectionRange` returns `null` unless the selection's start and end are inside the *same* annotated `<span data-src-*>`, i.e. the same source text run. Runs break at every inline element and block boundary, so long selections fail. Secondary failure: `remarkCriticmarkup.ts:17,37` emit position-less text nodes that `rehypeSourceSpans.ts:12` skips, so text next to an existing mark loses `data-src-*` entirely.

---

## File Structure

- **Create** `src/web/rehypeCriticMarkup.ts` — offset-driven hast pass that renders CriticMarkup as `<mark>` and preserves source offsets. Replaces `remarkCriticmarkup`.
- **Create** `src/web/rehypeCriticMarkup.test.ts` — unit tests over hast fixtures.
- **Create** `src/web/blockOffsets.ts` — small DOM helper: nearest block ancestor + a `sameBlock` check, used by selection mapping. (Kept separate so it is unit-testable and reused.)
- **Modify** `src/web/sourceOffset.ts` — rewrite `resolveSelectionRange` to support multi-run selections with endpoint verification, same-block scoping, and mark-overlap refusal; return a typed result.
- **Modify** `src/web/sourceOffset.test.ts` — expand (create if absent).
- **Modify** `src/web/MarkdownView.tsx` — swap `remarkCriticmarkup` for `rehypeCriticMarkup(spans)`; thread `spans` in.
- **Modify** `src/web/SelectionPopover.tsx` — consume the typed result; pass the **source** slice as `selectedText`; show a hint for refused selections.
- **Modify** `src/web/App.tsx` — compute `spans` once (memoized) and pass to `MarkdownView`; map new error strings to alerts.
- **Modify** `src/rfm/insert.ts` — add an overlap-with-existing-mark guard to `insertComment` (defense in depth on the 409 re-apply path).
- **Modify** `src/rfm/insert.test.ts` — cover the overlap guard.
- **Delete** `src/web/remarkCriticmarkup.ts` and `src/web/remarkCriticmarkup.test.ts` — superseded.

---

## Task 0: Spike — confirm hast positions (mostly done)

**Goal:** De-risk the load-bearing assumption: does the markdown→hast pipeline preserve `position.start/end.offset` on **element** nodes (not just text)? The wrap algorithm (Task 2) needs a `<strong>` inside a highlight's inner region to carry its own offset.

**Already verified by the plan author (2026-07-01)** using `mdast-util-to-hast@13.2.1` (the module `remark-rehype`/react-markdown delegate to). For `'foo {==bar **bold** baz==}{#c9} tail'` the hast tree was:

```
p                          0  36
text:"foo {==bar "         0  11
strong                     11 19    ← element carries offsets, = source '**bold**'
text:"bold"                13 17
text:" baz==}{#c9} tail"   19 36
```

So element positions ARE preserved. The dependency chain `react-markdown → remark-rehype → mdast-util-to-hast` copies `position` uniformly to text and element nodes, and the existing `rehypeSourceSpans.ts` already proves text positions survive into the rehype phase.

- [ ] **Step 1: Confirm in-repo with a throwaway test using the `remark` preset**

> Use the `remark` preset (NOT `unified`/`remark-parse`, which are not direct deps and won't resolve under pnpm). This mirrors the existing `src/web/remarkCriticmarkup.test.ts:2,8-14`.

```ts
import type { Element, Root } from 'hast';
import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { expect, test } from 'vitest';

test('SPIKE: element nodes keep source offsets through remark-rehype', () => {
  let captured: Root | null = null;
  remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => (tree: Root): void => { captured = tree; })
    .use(rehypeStringify)
    .processSync('foo {==bar **bold** baz==}{#c9} tail');
  if (captured === null) throw new Error('no tree captured');
  let strong: Element | null = null;
  visit(captured, 'element', (node: Element) => {
    if (node.tagName === 'strong') strong = node;
  });
  if (strong === null) throw new Error('no strong');
  expect((strong as Element).position?.start.offset).toBe(11);
  expect((strong as Element).position?.end.offset).toBe(19);
});
```

- [ ] **Step 2: Run it** — `pnpm vitest run src/web/_spike.test.ts` → PASS.

- [ ] **Step 3: Delete the spike** — `git rm -f src/web/_spike.test.ts` (or remove the file). Do not commit the spike.

> **Gate:** If Step 2 unexpectedly FAILS (element positions absent), STOP and flag the human — the Task 2 algorithm would then need to derive element ranges from descendant text-node offsets instead.

---

## Task 1: `blockOffsets.ts` — nearest-block helper

**Files:**
- Create: `src/web/blockOffsets.ts`
- Create: `src/web/blockOffsets.test.ts`

**Interfaces:**
- Produces:
  - `nearestBlock(node: Node | null, root: HTMLElement): HTMLElement | null` — walk up to the nearest block-level element (`P,H1..H6,LI,TD,TH,BLOCKQUOTE,DD,DT,PRE`) at or above `node`, stopping at `root`. Returns `null` if `node` is outside `root`.
  - `sameBlock(a: Node, b: Node, root: HTMLElement): boolean` — `nearestBlock(a)===nearestBlock(b)` and both non-null.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { nearestBlock, sameBlock } from './blockOffsets.js';

describe('nearestBlock', () => {
  it('finds the enclosing paragraph from a nested inline element', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p id="a">x <strong>y</strong> z</p><p id="b">w</p>';
    const strong = root.querySelector('strong');
    if (strong === null) throw new Error('setup');
    expect(nearestBlock(strong.firstChild, root)?.id).toBe('a');
  });

  it('sameBlock is false across two paragraphs', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p id="a">x</p><p id="b">y</p>';
    const a = root.querySelector('#a');
    const b = root.querySelector('#b');
    if (a?.firstChild == null || b?.firstChild == null) throw new Error('setup');
    expect(sameBlock(a.firstChild, b.firstChild, root)).toBe(false);
  });

  it('sameBlock is true for two inline runs in one paragraph', () => {
    const root = document.createElement('article');
    root.innerHTML = '<p id="a">x <strong>y</strong> z</p>';
    const p = root.querySelector('#a');
    const strong = root.querySelector('strong');
    if (p?.firstChild == null || strong?.firstChild == null) throw new Error('setup');
    expect(sameBlock(p.firstChild, strong.firstChild, root)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/web/blockOffsets.test.ts`
Expected: FAIL ("nearestBlock is not a function").

- [ ] **Step 3: Implement**

```ts
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'PRE']);

export function nearestBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el !== null && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

export function sameBlock(a: Node, b: Node, root: HTMLElement): boolean {
  const ba = nearestBlock(a, root);
  const bb = nearestBlock(b, root);
  return ba !== null && ba === bb;
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/web/blockOffsets.test.ts` → PASS.
- [ ] **Step 5: Lint/typecheck** — `pnpm lint && pnpm typecheck` → clean.
- [ ] **Step 6: Commit** — `git add src/web/blockOffsets.* && git commit -m "✨ feat(web): nearest-block DOM helper for selection scoping"`

---

## Task 2: `rehypeCriticMarkup` — offset-driven mark rendering

**Files:**
- Create: `src/web/rehypeCriticMarkup.ts`
- Create: `src/web/rehypeCriticMarkup.test.ts`
- (Task 3 deletes the old `remarkCriticmarkup`; leave it untouched here so both exist during this task.)

**Interfaces:**
- Consumes: `Span` from `../rfm/types.js`; `tokenize` output passed in as `spans`.
- Produces: `rehypeCriticMarkup(spans: Span[]): (tree: Root) => void`.

**Behavior spec (the algorithm):**
1. Ignore `substitution` spans (parity with v1: not rendered as a mark). Keep `highlight`, `comment`, `insertion`, `deletion`.
2. For every text node in the tree that carries `position.start/end.offset`, split it at any span boundary (`span.start`, `innerStart`, `innerEnd`, `span.end` for each span) that falls strictly inside the node, producing child text nodes that never straddle a boundary. Each resulting text node keeps a correct `[start,end)` offset.
3. Walk each block's phrasing children (top level of the block; do **not** descend into inline elements — nesting a mark inside `**bold**` is an unsupported v1.1 edge). Using offsets:
   - **Drop** any node fully inside a delimiter region `[span.start, innerStart)` or `[innerEnd, span.end)`.
   - **Wrap** the maximal consecutive run of nodes fully inside an inner region `[innerStart, innerEnd)` in a single `<mark>` element with `properties: { 'data-cm-kind': span.kind, ...(span.id !== undefined ? { 'data-cm-id': span.id } : {}) }`.
4. Element nodes (e.g. `<strong>`) inside an inner region are wrapped whole (their own text children keep offsets, so `rehypeSourceSpans` — which still runs — will annotate them for selection).

**Note on ordering:** In `MarkdownView` (Task 3), run `rehypeCriticMarkup` **before** `rehypeSourceSpans`, so source-span wrapping annotates the post-surgery text nodes (including those now inside `<mark>`).

- [ ] **Step 1: Write failing tests**

> Use the `remark` preset (matches `src/web/remarkCriticmarkup.test.ts`; `unified`/`remark-parse` are not direct deps and won't resolve under pnpm — see review C1).

```ts
import rehypeStringify from 'rehype-stringify';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../rfm/tokenize.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';

function render(src: string): string {
  return remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rehypeCriticMarkup(tokenize(src)))
    .use(rehypeStringify)
    .processSync(src)
    .toString();
}

describe('rehypeCriticMarkup', () => {
  it('renders a plain highlight as <mark> without leaking delimiters', () => {
    const html = render('a {==just highlight==} b');
    expect(html).toContain('<mark data-cm-kind="highlight">just highlight</mark>');
    expect(html).not.toContain('{==');
    expect(html).not.toContain('==}');
  });

  it('preserves inner markdown inside a highlight (the bug this fixes)', () => {
    const html = render('foo {==bar **bold** baz==}{#c9} tail');
    // inner bold survives, wrapped by the mark, no literal braces:
    expect(html).toMatch(/<mark data-cm-kind="highlight" data-cm-id="c9">bar <strong>bold<\/strong> baz<\/mark>/);
    expect(html).not.toContain('{#c9}');
    expect(html).not.toContain('{==');
  });

  it('renders adjacent highlight + comment as two marks', () => {
    const html = render('x {==sel==}{>>note<<}{#c1} y');
    expect(html).toContain('<mark data-cm-kind="highlight">sel</mark>');
    expect(html).toContain('<mark data-cm-kind="comment" data-cm-id="c1">note</mark>');
    expect(html).not.toContain('{>>');
    expect(html).not.toContain('<<}');
  });

  it('renders insertion and deletion', () => {
    const html = render('a {++ins++}{#s1} b {--del--}{#s2} c');
    expect(html).toContain('<mark data-cm-kind="insertion" data-cm-id="s1">ins</mark>');
    expect(html).toContain('<mark data-cm-kind="deletion" data-cm-id="s2">del</mark>');
  });

  it('leaves substitution untouched (not rendered as a mark in v1)', () => {
    const html = render('a {~~old~>new~~}{#s5} b');
    expect(html).not.toContain('data-cm-kind="substitution"');
  });

  it('handles a second mark elsewhere in an already-marked paragraph', () => {
    const html = render('one {==first==}{#c1} two {==second==}{#c2} three');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c1">first</mark>');
    expect(html).toContain('<mark data-cm-kind="highlight" data-cm-id="c2">second</mark>');
  });
});
```

> `remark`, `remark-gfm`, `remark-rehype`, `rehype-stringify` are all devDeps (verified) — this pipeline resolves. `data-cm-id` attribute ordering in the stringified output follows insertion order (`data-cm-kind` then `data-cm-id`), matching the `mark()` helper below.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/web/rehypeCriticMarkup.test.ts` → FAIL ("rehypeCriticMarkup is not a function").

- [ ] **Step 3: Implement** (reference implementation — adapt to Task 0 findings)

```ts
import type { Element, ElementContent, Root, Text } from 'hast';
import type { Span } from '../rfm/types.js';

const OPENER = 3;
const RENDERED_KINDS = new Set<Span['kind']>(['highlight', 'comment', 'insertion', 'deletion']);

interface Boundary { start: number; end: number; span: Span; }

function nodeOffsets(node: ElementContent): { start: number; end: number } | null {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  return s === undefined || e === undefined ? null : { start: s, end: e };
}

/** Split a text node so it never straddles any cut offset. Returns replacement nodes. */
function splitText(node: Text, cuts: number[]): Text[] {
  const off = node.position?.start.offset;
  if (off === undefined) return [node];
  const inside = cuts
    .filter((c) => c > off && c < off + node.value.length)
    .sort((a, b) => a - b);
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
  const cuts = rendered.flatMap((s) => [s.start, s.start + OPENER, s.start + OPENER + s.inner.length, s.end]);
  const inners: Boundary[] = rendered.map((s) => ({ start: s.start + OPENER, end: s.start + OPENER + s.inner.length, span: s }));
  const delims: Array<{ start: number; end: number }> = rendered.flatMap((s) => [
    { start: s.start, end: s.start + OPENER },
    { start: s.start + OPENER + s.inner.length, end: s.end },
  ]);

  function processChildren(children: ElementContent[]): ElementContent[] {
    // 1. split text nodes at boundaries
    const split: ElementContent[] = children.flatMap((c) => (c.type === 'text' ? splitText(c, cuts) : [c]));
    // 2. drop delimiter nodes, group inner nodes into marks
    const out: ElementContent[] = [];
    let i = 0;
    while (i < split.length) {
      const node = split[i];
      if (node === undefined) { i += 1; continue; }
      const o = nodeOffsets(node);
      const delim = o !== null && delims.some((d) => o.start >= d.start && o.end <= d.end);
      if (delim) { i += 1; continue; }
      const inner = o !== null ? inners.find((b) => o.start >= b.start && o.end <= b.end) : undefined;
      if (inner === undefined) { out.push(node); i += 1; continue; }
      const run: ElementContent[] = [];
      while (i < split.length) {
        const n = split[i];
        if (n === undefined) break;
        const no = nodeOffsets(n);
        if (no === null || !(no.start >= inner.start && no.end <= inner.end)) break;
        run.push(n);
        i += 1;
      }
      out.push(mark(inner.span.kind, inner.span.id, run));
    }
    return out;
  }

  // Block-level containers whose direct children form a phrasing line we process.
  // We recurse ONLY into these — never into inline elements (strong/em/code/a/mark),
  // otherwise a strong wrapped into a mark would have its inner text re-wrapped
  // (double-wrap bug). CriticMarkup delimiters live at the block's phrasing level
  // by v1.1 scope, so skipping inline elements is correct.
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'dd', 'dt', 'div', 'section', 'article']);

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
```

Notes for the implementer:
- `no-unnecessary-condition`/`noUncheckedIndexedAccess`: `split[i]` is `T | undefined`; the `undefined` guards above are required, keep them.
- **Do not recurse into inline elements** (see `BLOCK` above) — verified necessary: a `<strong>` inside a highlight's inner region is wrapped whole at the block level; recursing into it would match its child text against the same inner region and wrap it again. A nested block (e.g. a `<p>` inside a loose `<li>`) is larger than any inner region so `processChildren` leaves it untouched and `walk` recurses into it correctly.
- Do **not** wrap when `run` is empty (guard if Task 0 shows a boundary edge case).

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/web/rehypeCriticMarkup.test.ts` → PASS.
- [ ] **Step 5: Lint/typecheck** — `pnpm lint && pnpm typecheck` → clean.
- [ ] **Step 6: Commit** — `git commit -am "✨ feat(web): offset-driven rehypeCriticMarkup (composes with inline markdown)"`

---

## Task 3: Swap the pipeline in `MarkdownView`, wire `App`, remove `remarkCriticmarkup`

This task keeps the build green: `MarkdownView` gains required `spans` + optional `articleRef`, and `App.tsx` + `App.test.tsx` are updated in the SAME commit so `tsc -b` and `pnpm test` pass. `SelectionPopover` is left on its current signature here and updated in Task 5.

**Files:**
- Modify: `src/web/MarkdownView.tsx`
- Modify: `src/web/App.tsx` (memoize `doc`/`spans`, add `articleRef`, pass to `MarkdownView`; leave the `SelectionPopover` call as-is)
- Modify: `src/web/App.test.tsx` (pass the new `spans` prop)
- Delete: `src/web/remarkCriticmarkup.ts`, `src/web/remarkCriticmarkup.test.ts`

**Interfaces:**
- Consumes: `rehypeCriticMarkup` (Task 2), `Span`, `tokenize`.
- Produces: `MarkdownView({ source, spans, articleRef }: { source: string; spans: Span[]; articleRef?: RefObject<HTMLElement | null> })`.

- [ ] **Step 1: Update `MarkdownView`**

```tsx
import type { JSX, RefObject } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Span } from '../rfm/types.js';
import { rehypeCriticMarkup } from './rehypeCriticMarkup.js';
import { rehypeSourceSpans } from './rehypeSourceSpans.js';

export function MarkdownView({
  source,
  spans,
  articleRef,
}: {
  source: string;
  spans: Span[];
  articleRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  return (
    <article className="markdown-body" ref={articleRef}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[(): ((tree: import('hast').Root) => void) => rehypeCriticMarkup(spans), rehypeSourceSpans]}>
        {source}
      </Markdown>
    </article>
  );
}
```

- [ ] **Step 2: Wire `App.tsx`** — memoize the parse, compute `spans`, create `articleRef`, pass both to `MarkdownView`. Leave the `SelectionPopover`/`CommentSidebar` calls exactly as they are today (Task 5 changes `SelectionPopover`).

```tsx
// add imports:
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { tokenize } from '../rfm/tokenize.js';

// inside App(), after the `version` ref:
const doc = useMemo(() => (content === null ? null : parse(content)), [content]);
const spans = useMemo(() => (doc === null ? [] : tokenize(doc.body)), [doc]);
const articleRef = useRef<HTMLElement | null>(null);

// change the guard + render:
if (content === null || doc === null) return <div>Loading…</div>;
return (
  <div className="layout">
    <MarkdownView source={doc.body} spans={spans} articleRef={articleRef} />
    <SelectionPopover
      body={doc.body}
      onComment={(range, body, selectedText) =>
        void save(
          (src) =>
            insertComment(src, range, body, 'user', new Date().toISOString(), selectedText).md,
        )
      }
    />
    <CommentSidebar
      source={content}
      onReply={(pid, body) =>
        void save((src) => addReply(src, pid, body, 'user', new Date().toISOString()).md)
      }
      onResolve={(id) => void save((src) => setResolved(src, id, true))}
      onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
    />
  </div>
);
```

Note: this replaces the current inline `parse(content).body` calls (App.tsx:59,61) with the memoized `doc.body` (fixes the "parse runs 4×/render" tech-debt item too).

- [ ] **Step 3: Fix `App.test.tsx`** — it renders `<MarkdownView>` directly (App.test.tsx:8) and now needs `spans`:

```tsx
// change the render call to include the new required prop:
render(<MarkdownView source={'# Title\n\ntext'} spans={[]} />);
```

(Leave `articleRef` off — it is optional.)

- [ ] **Step 4: Delete the superseded remark plugin + its test**

```bash
git rm src/web/remarkCriticmarkup.ts src/web/remarkCriticmarkup.test.ts
```

- [ ] **Step 5: Verify green** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build:web`.
Expected: all clean/PASS. Existing marks in `demo.md` still render (confirm manually in Task 6).

- [ ] **Step 6: Commit** — `git commit -am "♻️ refactor(web): render CriticMarkup via rehype; memoize parse/spans"`

---

## Task 4: Rewrite `resolveSelectionRange` (multi-run, verified, scoped)

**Files:**
- Modify: `src/web/sourceOffset.ts`
- Create/modify: `src/web/sourceOffset.test.ts`

**Interfaces:**
- Consumes: `nearestBlock`/`sameBlock` from `./blockOffsets.js`; `tokenize` from `../rfm/tokenize.js`.
- Produces:

```ts
export type SelectionResult =
  | { ok: true; start: number; end: number; text: string }
  | { ok: false; reason: 'cross-block' | 'overlaps-mark' | 'unresolvable' };

// Returns null when there is nothing to act on (collapsed / no selection /
// selection not inside the rendered article). Returns a SelectionResult otherwise.
export function resolveSelectionRange(sel: Selection, body: string, root: HTMLElement): SelectionResult | null;
```

**Behavior spec:**
1. `rangeCount === 0 || isCollapsed` → `null`.
2. Find `startEl`/`endEl` = nearest ancestor with `dataset.srcStart`. If either is `null` → `null` (selection outside annotated content).
3. If `!sameBlock(startContainer, endContainer, root)` → `{ ok:false, reason:'cross-block' }`.
4. Compute `start` = `Number(startEl.dataset.srcStart)` + length of text from `startEl`'s content start to the range start (via a `Range` + `toString().length`). Compute `end` = `Number(endEl.dataset.srcStart)` + same for the end.
5. **Endpoint verification** (runs are plain text ⇒ source↔rendered is 1:1 within a run):
   - `body.slice(start, Number(startEl.dataset.srcEnd))` must equal the DOM text from range-start to end of `startEl`.
   - `body.slice(Number(endEl.dataset.srcStart), end)` must equal the DOM text from start of `endEl` to range-end.
   - If either fails → `{ ok:false, reason:'unresolvable' }`.
6. **Overlap guard:** if `[start,end)` intersects any `tokenize(body)` span's `[span.start, span.end)` → `{ ok:false, reason:'overlaps-mark' }`. (Selecting text that is itself part of an existing mark would create nested CriticMarkup.)
7. Otherwise `{ ok:true, start, end, text: body.slice(start, end) }`. Note `text` is the **source** slice (may contain markdown syntax), used verbatim as `expectedText`.

- [ ] **Step 1: Write failing tests** (jsdom; build a small annotated DOM by hand)

> **Replace the entire contents** of `src/web/sourceOffset.test.ts` — the existing tests call the old 2-arg `resolveSelectionRange(sel, body)` and assert the old `{start,end}` shape (`src/web/sourceOffset.test.ts` current), which no longer compiles. Do not append.

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSelectionRange } from './sourceOffset.js';

function sel(root: HTMLElement, startNode: Node, so: number, endNode: Node, eo: number): Selection {
  // jsdom's Selection only tracks ranges whose nodes are connected to the document.
  if (!root.isConnected) document.body.appendChild(root);
  const s = window.getSelection();
  if (s === null) throw new Error('no selection');
  s.removeAllRanges();
  const r = document.createRange();
  r.setStart(startNode, so);
  r.setEnd(endNode, eo);
  s.addRange(r);
  return s;
}

// Clean up appended roots between tests.
afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('resolveSelectionRange', () => {
  it('maps a selection spanning two runs across a <strong> (the reported bug)', () => {
    // body: "foo bar baz"  rendered as: <span 0-4>foo </span><strong><span 4-7>bar</span></strong><span 7-11> baz</span>
    const body = 'foo bar baz';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="4">foo </span>' +
      '<strong><span data-src-start="4" data-src-end="7">bar</span></strong>' +
      '<span data-src-start="7" data-src-end="11"> baz</span></p>';
    const first = root.querySelector('[data-src-start="0"]');
    const last = root.querySelector('[data-src-start="7"]');
    if (first?.firstChild == null || last?.firstChild == null) throw new Error('setup');
    const s = sel(root, first.firstChild, 0, last.firstChild, 4); // "foo bar baz"
    const res = resolveSelectionRange(s, body, root);
    expect(res).toEqual({ ok: true, start: 0, end: 11, text: 'foo bar baz' });
  });

  it('refuses a cross-block selection', () => {
    const body = 'a\n\nb';
    const root = document.createElement('article');
    root.innerHTML =
      '<p><span data-src-start="0" data-src-end="1">a</span></p>' +
      '<p><span data-src-start="3" data-src-end="4">b</span></p>';
    const a = root.querySelector('[data-src-start="0"]');
    const b = root.querySelector('[data-src-start="3"]');
    if (a?.firstChild == null || b?.firstChild == null) throw new Error('setup');
    const res = resolveSelectionRange(sel(root, a.firstChild, 0, b.firstChild, 1), body, root);
    expect(res).toEqual({ ok: false, reason: 'cross-block' });
  });

  it('refuses a selection overlapping an existing mark', () => {
    const body = 'x {==m==} y';
    const root = document.createElement('article');
    // rendered run covering "x " and then the mark; select into "x <mark>"
    root.innerHTML = '<p><span data-src-start="0" data-src-end="2">x </span>' +
      '<mark data-cm-kind="highlight"><span data-src-start="5" data-src-end="6">m</span></mark>' +
      '<span data-src-start="9" data-src-end="11"> y</span></p>';
    const x = root.querySelector('[data-src-start="0"]');
    const m = root.querySelector('[data-src-start="5"]');
    if (x?.firstChild == null || m?.firstChild == null) throw new Error('setup');
    const res = resolveSelectionRange(sel(root, x.firstChild, 0, m.firstChild, 1), body, root);
    expect(res).toEqual({ ok: false, reason: 'overlaps-mark' });
  });

  it('returns null for a collapsed selection', () => {
    const body = 'abc';
    const root = document.createElement('article');
    root.innerHTML = '<p><span data-src-start="0" data-src-end="3">abc</span></p>';
    const n = root.querySelector('[data-src-start="0"]');
    if (n?.firstChild == null) throw new Error('setup');
    expect(resolveSelectionRange(sel(root, n.firstChild, 1, n.firstChild, 1), body, root)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/web/sourceOffset.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { tokenize } from '../rfm/tokenize.js';
import { nearestBlock } from './blockOffsets.js';

function annotatedAncestor(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el !== null && el.dataset['srcStart'] === undefined) el = el.parentElement;
  return el;
}

function textFromContentStart(el: HTMLElement, container: Node, offset: number): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(container, offset);
  return r.toString();
}

function textToContentEnd(el: HTMLElement, container: Node, offset: number): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setStart(container, offset);
  return r.toString();
}

export type SelectionResult =
  | { ok: true; start: number; end: number; text: string }
  | { ok: false; reason: 'cross-block' | 'overlaps-mark' | 'unresolvable' };

export function resolveSelectionRange(
  sel: Selection,
  body: string,
  root: HTMLElement,
): SelectionResult | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = annotatedAncestor(range.startContainer);
  const endEl = annotatedAncestor(range.endContainer);
  if (startEl === null || endEl === null) return null;

  const bStart = nearestBlock(range.startContainer, root);
  const bEnd = nearestBlock(range.endContainer, root);
  if (bStart === null || bStart !== bEnd) return { ok: false, reason: 'cross-block' };

  const sBase = startEl.dataset['srcStart'];
  const sEndAttr = startEl.dataset['srcEnd'];
  const eBase = endEl.dataset['srcStart'];
  if (sBase === undefined || sEndAttr === undefined || eBase === undefined) return { ok: false, reason: 'unresolvable' };

  const startHead = textFromContentStart(startEl, range.startContainer, range.startOffset);
  const endHead = textFromContentStart(endEl, range.endContainer, range.endOffset);
  const start = Number(sBase) + startHead.length;
  const end = Number(eBase) + endHead.length;
  if (!(start < end) || end > body.length) return { ok: false, reason: 'unresolvable' };

  // Endpoint verification by STRING equality (each run is plain text ⇒ source == rendered
  // within a run). This is the guard against silent mis-anchoring, so compare content, not
  // just length: the source from the computed start to the run's source-end must equal the
  // DOM text from the selection start to the run's end; symmetrically for the end run.
  const startTail = textToContentEnd(startEl, range.startContainer, range.startOffset);
  if (body.slice(start, Number(sEndAttr)) !== startTail) return { ok: false, reason: 'unresolvable' };
  if (body.slice(Number(eBase), end) !== endHead) return { ok: false, reason: 'unresolvable' };

  for (const span of tokenize(body)) {
    if (start < span.end && span.start < end) return { ok: false, reason: 'overlaps-mark' };
  }
  return { ok: true, start, end, text: body.slice(start, end) };
}
```

Implementer note: endpoint checks compare STRINGS (not lengths) — the whole point is preventing silent mis-anchoring, so verify content. Within a single annotated run the DOM text equals the source slice 1:1 (runs are plain text with no markdown syntax), so this holds; if it ever fails, returning `unresolvable` is the safe outcome.

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/web/sourceOffset.test.ts` → PASS.
- [ ] **Step 5: Lint/typecheck** — clean.
- [ ] **Step 6: Commit** — `git commit -am "✨ feat(web): resolve multi-run selections with scoping + overlap guard"`

---

## Task 5: Wire `App` / `SelectionPopover`, add `insertComment` overlap guard

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/SelectionPopover.tsx`
- Modify: `src/rfm/insert.ts`
- Modify: `src/rfm/insert.test.ts`

**Interfaces:**
- Consumes: `SelectionResult` (Task 4); `articleRef` (created in Task 3) is passed to the new `SelectionPopover`.
- Produces: `SelectionPopover({ body, rootRef, onComment })`.

- [ ] **Step 1 (rfm): failing test for the overlap guard**

```ts
import { describe, expect, it } from 'vitest';
import { insertComment } from './insert.js';

describe('insertComment overlap guard', () => {
  it('throws when the range overlaps an existing mark', () => {
    const md = 'x {==m==}{#c1} y';
    // offsets of "m" inner are inside the existing highlight span -> must refuse
    expect(() => insertComment(md, [5, 6], 'note', 'user', '2026-07-01T00:00:00.000Z')).toThrow(/overlap/);
  });

  it('allows a non-overlapping range in an already-marked doc', () => {
    const md = 'x {==m==}{#c1} yy';
    const start = md.indexOf('yy');
    const out = insertComment(md, [start, start + 2], 'note', 'user', '2026-07-01T00:00:00.000Z');
    expect(out.md).toContain('{==yy==}');
  });
});
```

- [ ] **Step 2 (rfm): run → FAIL** — `pnpm vitest run src/rfm/insert.test.ts`.

- [ ] **Step 3 (rfm): implement the guard in `insertComment`** (add after the `expectedText` check, before `assertSafe`):

```ts
import { tokenize } from './tokenize.js';
// ...
for (const span of tokenize(doc.body)) {
  if (start < span.end && span.start < end) throw new Error('selection overlaps an existing mark');
}
```

- [ ] **Step 4 (rfm): run → PASS.**

- [ ] **Step 5 (web): update `SelectionPopover`** to consume `SelectionResult`, pass the **source** slice, and surface refusals:

```tsx
import { type JSX, type RefObject, useEffect, useState } from 'react';
import { resolveSelectionRange, type SelectionResult } from './sourceOffset.js';

interface PopoverState { result: SelectionResult; x: number; y: number; }

export function SelectionPopover({
  body,
  rootRef,
  onComment,
}: {
  body: string;
  rootRef: RefObject<HTMLElement | null>;
  onComment: (range: [number, number], commentBody: string, selectedText: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<PopoverState | null>(null);

  useEffect(() => {
    function onMouseUp(): void {
      const sel = window.getSelection();
      const root = rootRef.current;
      if (sel === null || root === null) { setState(null); return; }
      const result = resolveSelectionRange(sel, body, root);
      if (result === null) { setState(null); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setState({ x: rect.left + window.scrollX, y: rect.bottom + window.scrollY, result });
    }
    document.addEventListener('mouseup', onMouseUp);
    return (): void => { document.removeEventListener('mouseup', onMouseUp); };
  }, [body, rootRef]);

  if (state === null) return null;
  const { result } = state;
  return (
    <div className="selection-popover" style={{ position: 'absolute', left: state.x, top: state.y }}>
      {result.ok ? (
        <button
          onClick={() => {
            const commentBody = window.prompt('Comment:');
            if (commentBody !== null && commentBody.trim().length > 0)
              onComment([result.start, result.end], commentBody.trim(), result.text);
            setState(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          💬 Comment
        </button>
      ) : (
        <span className="selection-hint">
          {result.reason === 'cross-block'
            ? '段落をまたぐ選択にはコメントできません'
            : result.reason === 'overlaps-mark'
              ? '既存のマークと重なる範囲にはコメントできません'
              : 'この範囲は選択できません'}
        </span>
      )}
    </div>
  );
}
```

Add a `.selection-hint` style to `src/web/theme.css` (small, muted text on the popover background):

```css
.selection-hint { color: #fff; font-size: 0.8rem; white-space: nowrap; }
```

- [ ] **Step 6 (web): update the `SelectionPopover` call + `save()` error handling in `App.tsx`**

The memoized `doc`/`spans` and `articleRef` already exist from Task 3. Only two edits remain here:

(a) Pass `rootRef={articleRef}` to `SelectionPopover` (it now needs the article root to scope selections):

```tsx
<SelectionPopover
  body={doc.body}
  rootRef={articleRef}
  onComment={(range, body, selectedText) =>
    void save(
      (src) => insertComment(src, range, body, 'user', new Date().toISOString(), selectedText).md,
    )
  }
/>
```

`selectedText` is now the **source** slice (Task 4's `result.text`), which flows into `insertComment`'s `expectedText` — a stronger integrity guard than the old rendered `sel.toString()`.

(b) Add an overlap branch to the `save()` catch (App.tsx:37-43):

```tsx
if (err instanceof Error && err.message === 'selection moved') {
  alert('The text moved while you were commenting — please re-select and try again.');
} else if (err instanceof Error && err.message.includes('overlap')) {
  alert('既存のマークと重なる範囲にはコメントできません。');
} else {
  alert('save failed (network or server error)');
}
```

- [ ] **Step 7: Run all web + rfm tests** — `pnpm test` → PASS.
- [ ] **Step 8: Lint/typecheck/build** — `pnpm lint && pnpm typecheck && pnpm build` → clean.
- [ ] **Step 9: Commit** — `git commit -am "✨ feat: comment across inline formatting; refuse unsafe selections"`

---

## Task 6: Integration test + manual verification

**Files:**
- Create: `src/web/App.integration.test.tsx` (jsdom + @testing-library/react)

- [ ] **Step 1: Write an integration test** that renders `App` against a stubbed `api.ts` (`getFile` returns a fixture with inline formatting, `putFile` captures the written content), simulates selecting across a `<strong>`, clicks 💬 Comment (stub `window.prompt`), and asserts the captured PUT body contains `{==…==}{>>…<<}{#c…}` wrapping the correct source range. Follow the existing test setup conventions in `src/web` (jsdom project, `@testing-library/jest-dom/vitest`).

> `vi.mock` is hoisted above imports, so its factory cannot close over a normal outer `const`; use `vi.hoisted` for shared mutable state (standard vitest pattern). `putFile(content, baseVersion)` and `subscribe(onVersion)` match `src/web/api.ts:7-25`.

```tsx
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({
  state: {
    content: 'This is **bold** and plain text.\n',
    version: 'v0',
    puts: [] as { baseVersion: string; content: string }[],
  },
}));

vi.mock('./api.js', () => ({
  getFile: (): Promise<{ content: string; version: string }> =>
    Promise.resolve({ content: h.state.content, version: h.state.version }),
  putFile: (content: string, baseVersion: string): Promise<{ ok: true; version: string }> => {
    h.state.puts.push({ content, baseVersion });
    return Promise.resolve({ ok: true, version: 'v1' });
  },
  subscribe: (): (() => void) => (): void => undefined,
}));

// Import App AFTER the mock is declared (vi.mock is hoisted, so this is safe).
const { App } = await import('./App.js');

beforeEach(() => {
  h.state.puts = [];
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});

test('commenting across bold writes a well-formed highlight', async () => {
  const { container } = render(<App />);

  // 1. wait for content to render (getFile resolves in an effect)
  await waitFor(() => {
    if (container.querySelector('strong') === null) throw new Error('not rendered yet');
  });

  // 2. locate the annotated runs: run at source offset 0 ("This is ") and offset 16 (" and plain text.")
  const runs = Array.from(container.querySelectorAll<HTMLElement>('[data-src-start]'));
  const first = runs.find((s) => s.dataset['srcStart'] === '0');
  const third = runs.find((s) => s.dataset['srcStart'] === '16');
  if (first?.firstChild == null || third?.firstChild == null) throw new Error('setup: annotated runs missing');

  // 3. select "This is **bold** and" (rendered: "This is bold and"), crossing the <strong>
  const sel = window.getSelection();
  if (sel === null) throw new Error('no selection');
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(first.firstChild, 0);
  r.setEnd(third.firstChild, 4); // " and"
  sel.addRange(r);
  fireEvent.mouseUp(document);

  // 4. the popover shows the Comment button; stub prompt and click
  const btn = await waitFor(() => {
    const b = container.querySelector<HTMLButtonElement>('.selection-popover button');
    if (b === null) throw new Error('no comment button');
    return b;
  });
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('note');
  fireEvent.click(btn);
  promptSpy.mockRestore();

  // 5. the PUT body wraps the correct SOURCE range (incl. the **bold** markup), with a comment + id
  await waitFor(() => {
    if (h.state.puts.length === 0) throw new Error('no PUT captured');
  });
  expect(h.state.puts[0]?.content).toContain('{==This is **bold** and==}{>>note<<}{#c1}');
});
```

> jsdom risk: `Selection.addRange` + `Range.toString()` must work in the vitest jsdom env (they do in current jsdom). If `getBoundingClientRect` returning zeros or a Selection quirk blocks the popover, fall back to asserting `resolveSelectionRange` + `insertComment` composition directly (unit-level) and keep the manual smoke test (Step 3) as the end-to-end check. Note this fallback in the review package if used.

- [ ] **Step 2: Run → iterate to green** — `pnpm vitest run src/web/App.integration.test.tsx`.

- [ ] **Step 3: Manual smoke test**

```bash
pnpm build
node dist/cli/index.js stop || true
node dist/cli/index.js open demo.md
```
In the browser: (a) select a phrase spanning `**bold**`/`` `code` `` → 💬 appears → comment saves and the highlight renders with inner formatting intact (no literal braces); (b) select a second phrase in the already-commented paragraph → works; (c) try selecting across two paragraphs → hint shown, no crash; (d) try selecting text already inside a mark → hint shown.

- [ ] **Step 4: Commit** — `git commit -am "✅ test(web): integration coverage for cross-formatting commenting"`

---

## Out of scope (record as tech debt if not done)

- **Substitution rendering** (`{~~old~>new~~}`) remains unrendered as a mark (parity with v1). GFM parses `~~…~~` as strikethrough; proper rendering needs the same offset surgery plus del/ins handling.
- **CriticMarkup nested inside inline markup** (`**{==x==}**`) — the wrap only groups a block's top-level phrasing siblings, so a mark whose delimiters sit inside a `<strong>` won't render/select. Rare; document it.
- **Cross-block comments** — intentionally refused (CriticMarkup is inline; a highlight spanning `\n\n` is malformed). If ever needed, it requires multi-span emission, not a single wrap.
- Update `memory/v1-tech-debt.md`: the "2nd selection-comment in an already-marked paragraph is impossible" item is **resolved** by this plan (Task 2 removes position-less nodes; Task 4 handles non-overlapping selections in marked paragraphs). Remove or annotate it.

## Self-review notes

- Spec coverage: reported bug (cross-inline selection) → Tasks 2+4; already-marked-paragraph tech debt → Tasks 2+4; silent failure UX → Task 5 hint; data-safety on 409 re-apply → Task 5 overlap guard + endpoint STRING verification + existing `expectedText` (now the source slice).
- Type consistency: `SelectionResult` (Task 4) consumed in Task 5; `MarkdownView({source,spans,articleRef?})` (Task 3) called in Tasks 3+5 with `articleRef`; `SelectionPopover({body,rootRef,onComment})` (Task 5) called in App with `rootRef={articleRef}`; `insertComment` signature unchanged (6 args, `expectedText` optional) — the overlap guard is internal.
- Green-per-task: Task 3 folds the `App.tsx`/`App.test.tsx` wiring into the same commit so the build never goes red (review I2/I3); each other task ends with `pnpm lint && typecheck && test`.
- Applied structural review (2026-07-01): C1 (pnpm module resolution — use `remark` preset, not `unified`/`remark-parse`), I2/I6 (existing `App.test.tsx`/`sourceOffset.test.ts` fixed/replaced), I3/I5 (`MarkdownView` ref via optional `articleRef` prop; App wiring in Task 3), I4 (Task 6 integration test fully written), S3 (endpoint verification is string-based). Load-bearing assumption (element positions preserved through to-hast) empirically confirmed — see Task 0.
- Risk: the offset surgery (Task 2) is the highest-risk piece; Task 0 spike de-risks the position assumption before any real code, and Task 2 is fully TDD'd across all five constructs.
