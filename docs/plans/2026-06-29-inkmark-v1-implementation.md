# inkmark v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first single-file Markdown viewer that renders CriticMarkup comments and lets a human add comments/suggestions in the browser, while an AI agent participates by editing the `.md` file directly.

**Architecture:** A pure-function `rfm` module owns all CriticMarkup parsing/serialization/insertion. A Hono server (bound to loopback) reads/writes the one opened file and pushes file-change events over SSE (driven by a directory-scoped chokidar watch). A React/Vite SPA renders the markdown **body** (endmatter stripped) + comments and turns text selections into CriticMarkup writes through the server. The human and the AI both converge on writing the same `.md` file.

**Tech Stack:** TypeScript (ESM), Node ≥20, pnpm, Hono + @hono/node-server, chokidar, `yaml`, React 19 + react-markdown 10 + remark-gfm, Vite, Vitest 3 (node + jsdom).

## Global Constraints

- Node ≥ 20 (developed on 24.16.0); package is ESM (`"type": "module"`).
- Package manager: **pnpm** (10.33.2).
- TypeScript strict; all source under `src/`, tests colocated as `*.test.ts(x)`. **`src/web` is type-checked** via a dedicated tsconfig.
- CriticMarkup metadata lives in a trailing YAML **endmatter** block separated by a line containing exactly `---`. The endmatter is **never rendered** to the user.
- CriticMarkup forms: comment `{>>x<<}`, highlight `{==x==}`, insertion `{++x++}`, deletion `{--x--}`, substitution `{~~old~>new~~}`; ids attached as `{#cN}` / `{#sN}`.
- Comment thread root body lives **inline** in `{>>...<<}`; replies are separate ids with `body` + `re:` in endmatter and no inline marker (roughdraft-compatible).
- Author label: human writes `by: user`; AI writes `by: AI`.
- **Conflict version = `sha256(content)`** (content-only; no mtime — stable across atomic rename).
- v1 anchoring: selection limited to **one contiguous source text run** (a single rendered text node); the write is verified (`body.slice(start,end) === selectionText`) and rejected if it would not round-trip.
- Server binds to **`127.0.0.1`** only and rejects requests whose `Host` is not localhost (DNS-rebinding guard).
- v1 **renders** comment/highlight/insertion/deletion inline; **substitution** (`{~~~~}`) is parsed and actionable in the sidebar but **not** rendered as an inline mark (it collides with GFM `~~strikethrough~~`; inline rendering deferred).
- Default port 4747; auto-select a free loopback port if taken.
- Never swallow errors silently — surface via HTTP status + UI feedback, or CLI exit code. Client-facing error bodies are generic; details are logged server-side.

---

## File Structure

```
inkmark/
├─ package.json
├─ tsconfig.json                # server/cli/rfm (excludes web + tests)
├─ tsconfig.web.json            # web (jsx, includes src/web) — typecheck only
├─ vitest.config.ts             # projects: node (rfm/server/cli) + jsdom (web)
├─ vite.config.ts               # web build → dist/web, dev proxy to server
├─ bin/inkmark                   # #!/usr/bin/env node → dist/cli/index.js
├─ src/
│  ├─ rfm/
│  │  ├─ types.ts               # CommentMeta, SuggestionMeta, Endmatter, Span, ParsedDoc
│  │  ├─ endmatter.ts           # splitEndmatter / parseEndmatter / serializeEndmatter
│  │  ├─ tokenize.ts            # scan body → CriticMarkup spans with offsets
│  │  ├─ parse.ts               # parse(md) → ParsedDoc; nextId()
│  │  ├─ insert.ts              # insertComment / addReply / setResolved
│  │  ├─ suggest.ts             # applySuggestion(md, id, accept|reject)
│  │  └─ index.ts               # public re-exports
│  ├─ server/
│  │  ├─ version.ts             # computeVersion(content)
│  │  ├─ fileStore.ts           # opened path; read/atomicWrite; lastWritten version
│  │  ├─ app.ts                 # Hono app: host guard + API + static SPA
│  │  ├─ watch.ts               # directory-scoped chokidar → change events
│  │  └─ start.ts               # bind 127.0.0.1, free port, { url, port, close }
│  ├─ cli/
│  │  ├─ port.ts                # findFreePort (loopback)
│  │  └─ index.ts               # open / status / stop
│  └─ web/
│     ├─ index.html
│     ├─ main.tsx               # imports theme.css
│     ├─ theme.css              # github-markdown-css + layout + mark colors
│     ├─ api.ts                 # getFile / putFile (409-aware) / subscribe
│     ├─ remarkCriticmarkup.ts  # text → <mark> via hChildren (renders inner text)
│     ├─ rehypeSourceSpans.ts   # wrap source text nodes in <span data-src-*>
│     ├─ sourceOffset.ts        # resolveSelectionRange (single run + verify)
│     ├─ MarkdownView.tsx       # react-markdown(body) + plugins
│     ├─ CommentSidebar.tsx     # threads + replies + resolve + suggestions accept/reject
│     ├─ SelectionPopover.tsx   # selection → range → comment
│     └─ App.tsx                # fetch body, save via pure transforms (409 re-apply)
└─ docs/                        # design + this plan
```

---

## Task 1: Project scaffold + toolchain smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.web.json`, `vitest.config.ts`, `src/rfm/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable pnpm/TS package with a green Vitest run and working `typecheck` + `typecheck:web`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "inkmark",
  "version": "0.0.0",
  "type": "module",
  "bin": { "inkmark": "bin/inkmark" },
  "scripts": {
    "build:server": "tsc -p tsconfig.json",
    "build:web": "vite build",
    "build": "pnpm build:server && pnpm build:web",
    "dev:web": "vite",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:web": "tsc -p tsconfig.web.json --noEmit"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "chokidar": "^4.0.0",
    "github-markdown-css": "^5.8.0",
    "hono": "^4.6.0",
    "open": "^10.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^10.0.0",
    "remark-gfm": "^4.0.0",
    "unist-util-visit": "^5.0.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/hast": "^3.0.0",
    "@types/mdast": "^4.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.0",
    "rehype-stringify": "^10.0.0",
    "remark": "^15.0.0",
    "remark-rehype": "^11.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

> `remark`/`remark-rehype`/`rehype-stringify` are dev-only, used to unit-test the remark plugin (Task 13). `vitest ^3` is required for inline `test.projects`. `@types/mdast` + `@types/hast` are required because pnpm's strict layout won't expose transitive type packages.

- [ ] **Step 2: Write `tsconfig.json`** (server/cli/rfm; excludes web + tests)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["src/web", "**/*.test.ts", "**/*.test.tsx"]
}
```

- [ ] **Step 3: Write `tsconfig.web.json`** (web typecheck only — no emit)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/web", "src/rfm"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/rfm/**/*.test.ts", "src/server/**/*.test.ts", "src/cli/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          setupFiles: ["@testing-library/jest-dom/vitest"],
          include: ["src/web/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
```

- [ ] **Step 5: Write the smoke test `src/rfm/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: install succeeds; Vitest prints `1 passed` for the `node` project; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json tsconfig.web.json vitest.config.ts src/rfm/smoke.test.ts pnpm-lock.yaml
git commit -m "🧱 chore: scaffold pnpm + TS + vitest 3 toolchain"
```

---

## Task 2: rfm — endmatter split & YAML (de)serialize

**Files:**
- Create: `src/rfm/types.ts`, `src/rfm/endmatter.ts`, `src/rfm/endmatter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `types.ts`: `CommentMeta { by; at; re?; body?; resolved? }`, `SuggestionMeta { by; at; resolved? }`, `Endmatter { comments; suggestions }`
  - `endmatter.ts`: `splitEndmatter(md) → { body; endmatterRaw; bodyEnd }`, `parseEndmatter(raw) → Endmatter`, `serializeEndmatter(e) → string` (returns `""` when empty).

- [ ] **Step 1: Write `src/rfm/types.ts`**

```ts
export interface CommentMeta {
  by: string;
  at: string;
  re?: string;
  body?: string;
  resolved?: boolean;
}
export interface SuggestionMeta {
  by: string;
  at: string;
  resolved?: boolean;
}
export interface Endmatter {
  comments: Record<string, CommentMeta>;
  suggestions: Record<string, SuggestionMeta>;
}
```

- [ ] **Step 2: Write failing test `src/rfm/endmatter.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { splitEndmatter, parseEndmatter, serializeEndmatter } from "./endmatter.js";

const DOC = `Hello {>>hi<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-06-29T00:00:00.000Z"
`;

describe("endmatter", () => {
  it("splits body from endmatter without doubling the trailing newline", () => {
    const { body, endmatterRaw } = splitEndmatter(DOC);
    expect(body).toBe("Hello {>>hi<<}{#c1}\n");
    expect(endmatterRaw).toContain("comments:");
  });

  it("returns null endmatter when there is no --- block", () => {
    const { body, endmatterRaw } = splitEndmatter("Just text\n");
    expect(body).toBe("Just text\n");
    expect(endmatterRaw).toBeNull();
  });

  it("parses comments and suggestions, defaulting empty", () => {
    const e = parseEndmatter("comments:\n  c1:\n    by: user\n    at: \"t\"\n");
    expect(e.comments.c1).toEqual({ by: "user", at: "t" });
    expect(e.suggestions).toEqual({});
  });

  it("serializes empty endmatter to an empty string", () => {
    expect(serializeEndmatter({ comments: {}, suggestions: {} })).toBe("");
  });

  it("round-trips through serialize", () => {
    const e = parseEndmatter(splitEndmatter(DOC).endmatterRaw);
    const again = parseEndmatter(serializeEndmatter(e));
    expect(again).toEqual(e);
  });

  it("degrades to empty on malformed YAML", () => {
    expect(parseEndmatter(":\n  bad: [")).toEqual({ comments: {}, suggestions: {} });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/rfm/endmatter.test.ts`
Expected: FAIL (cannot find module `./endmatter.js`).

- [ ] **Step 4: Write `src/rfm/endmatter.ts`**

```ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Endmatter } from "./types.js";

const FENCE = /\n---[ \t]*\n/g;

export function splitEndmatter(md: string): {
  body: string;
  endmatterRaw: string | null;
  bodyEnd: number;
} {
  let lastIdx = -1;
  let match: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((match = FENCE.exec(md)) !== null) lastIdx = match.index;
  if (lastIdx === -1) return { body: md, endmatterRaw: null, bodyEnd: md.length };

  const after = md.slice(lastIdx).replace(/^\n---[ \t]*\n/, "");
  // Only treat as endmatter if it parses as a mapping with comments/suggestions.
  try {
    const obj = parseYaml(after);
    if (obj && typeof obj === "object" && ("comments" in obj || "suggestions" in obj)) {
      // lastIdx points at the newline that begins "\n---\n"; the body's own
      // trailing newline is already included in slice(0, lastIdx).
      return { body: md.slice(0, lastIdx), endmatterRaw: after, bodyEnd: lastIdx };
    }
  } catch {
    /* fall through */
  }
  return { body: md, endmatterRaw: null, bodyEnd: md.length };
}

export function parseEndmatter(raw: string | null): Endmatter {
  const empty: Endmatter = { comments: {}, suggestions: {} };
  if (!raw) return empty;
  try {
    const obj = parseYaml(raw) as Partial<Endmatter> | null;
    if (!obj || typeof obj !== "object") return empty;
    return { comments: obj.comments ?? {}, suggestions: obj.suggestions ?? {} };
  } catch {
    return empty;
  }
}

export function serializeEndmatter(e: Endmatter): string {
  const hasComments = Object.keys(e.comments).length > 0;
  const hasSuggestions = Object.keys(e.suggestions).length > 0;
  if (!hasComments && !hasSuggestions) return "";
  const out: Record<string, unknown> = {};
  if (hasComments) out.comments = e.comments;
  if (hasSuggestions) out.suggestions = e.suggestions;
  return stringifyYaml(out);
}
```

> Note: `DOC` is `...{#c1}\n\n---\n...`; the regex matches at the blank-line newline (index 20), so `slice(0, 20)` yields `"Hello {>>hi<<}{#c1}\n"` — a single newline, matching the test.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/rfm/endmatter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/rfm/types.ts src/rfm/endmatter.ts src/rfm/endmatter.test.ts
git commit -m "✨ feat(rfm): endmatter split + YAML (de)serialize (empty → '')"
```

---

## Task 3: rfm — CriticMarkup tokenizer

**Files:**
- Create: `src/rfm/tokenize.ts`, `src/rfm/tokenize.test.ts`
- Modify: `src/rfm/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `types.ts` add: `type MarkKind = "comment" | "highlight" | "insertion" | "deletion" | "substitution";` and `interface Span { kind; start; end; inner; oldText?; newText?; id? }` (offsets into `body`; `start..end` cover the full `{...}` plus a trailing `{#id}`).
  - `tokenize.ts`: `tokenize(body: string): Span[]`.

- [ ] **Step 1: Add types to `src/rfm/types.ts`**

```ts
export type MarkKind =
  | "comment"
  | "highlight"
  | "insertion"
  | "deletion"
  | "substitution";

export interface Span {
  kind: MarkKind;
  start: number; // offset in body, inclusive
  end: number; // offset in body, exclusive
  inner: string; // raw inner text
  oldText?: string; // substitution
  newText?: string; // substitution
  id?: string; // from a trailing {#cN}/{#sN}
}
```

- [ ] **Step 2: Write failing test `src/rfm/tokenize.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { tokenize } from "./tokenize.js";

describe("tokenize", () => {
  it("finds a highlight+comment pair with an id", () => {
    const body = "a {==x==}{>>note<<}{#c1} b";
    const spans = tokenize(body);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ kind: "highlight", inner: "x" });
    expect(spans[1]).toMatchObject({ kind: "comment", inner: "note", id: "c1" });
    expect(body.slice(spans[1]!.start, spans[1]!.end)).toBe("{>>note<<}{#c1}");
  });

  it("parses a substitution into old/new", () => {
    const spans = tokenize("{~~old~>new~~}{#s1}");
    expect(spans[0]).toMatchObject({ kind: "substitution", oldText: "old", newText: "new", id: "s1" });
  });

  it("parses insertion and deletion", () => {
    expect(tokenize("{++add++} {--del--}").map((s) => s.kind)).toEqual(["insertion", "deletion"]);
  });

  it("ignores CriticMarkup inside fenced code blocks", () => {
    const spans = tokenize("```\n{>>literal<<}\n```\nreal {>>c<<}");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.inner).toBe("c");
  });

  it("returns empty for plain text", () => {
    expect(tokenize("no marks here")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/rfm/tokenize.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 4: Write `src/rfm/tokenize.ts`**

```ts
import type { MarkKind, Span } from "./types.js";

const OPENERS: Record<string, MarkKind> = {
  "{>>": "comment",
  "{==": "highlight",
  "{++": "insertion",
  "{--": "deletion",
  "{~~": "substitution",
};
const CLOSERS: Record<MarkKind, string> = {
  comment: "<<}",
  highlight: "==}",
  insertion: "++}",
  deletion: "--}",
  substitution: "~~}",
};
const ID_RE = /^\{#([a-zA-Z]+\d+)\}/;

function fencedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^```[^\n]*\n[\s\S]*?^```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

export function tokenize(body: string): Span[] {
  const skip = fencedRanges(body);
  const inSkip = (i: number) => skip.some(([a, b]) => i >= a && i < b);
  const spans: Span[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "{" || inSkip(i)) {
      i++;
      continue;
    }
    const opener = body.slice(i, i + 3);
    const kind = OPENERS[opener];
    if (!kind) {
      i++;
      continue;
    }
    const closer = CLOSERS[kind];
    const closeAt = body.indexOf(closer, i + 3);
    if (closeAt === -1) {
      i++;
      continue;
    }
    const inner = body.slice(i + 3, closeAt);
    let end = closeAt + closer.length;
    let id: string | undefined;
    const idMatch = ID_RE.exec(body.slice(end));
    if (idMatch) {
      id = idMatch[1];
      end += idMatch[0].length;
    }
    const span: Span = { kind, start: i, end, inner };
    if (kind === "substitution") {
      const arrow = inner.indexOf("~>");
      span.oldText = arrow === -1 ? inner : inner.slice(0, arrow);
      span.newText = arrow === -1 ? "" : inner.slice(arrow + 2);
    }
    if (id) span.id = id;
    spans.push(span);
    i = end;
  }
  return spans;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/rfm/tokenize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/rfm/tokenize.ts src/rfm/tokenize.test.ts src/rfm/types.ts
git commit -m "✨ feat(rfm): CriticMarkup tokenizer with source offsets"
```

---

## Task 4: rfm — parse() model + nextId()

**Files:**
- Create: `src/rfm/parse.ts`, `src/rfm/parse.test.ts`, `src/rfm/index.ts`
- Modify: `src/rfm/types.ts`

**Interfaces:**
- Consumes: `splitEndmatter`, `parseEndmatter` (Task 2); `tokenize` (Task 3).
- Produces:
  - `types.ts` add: `interface ParsedDoc { body: string; endmatterRaw: string | null; spans: Span[]; endmatter: Endmatter; }`
  - `parse.ts`: `parse(md) → ParsedDoc`, `nextId(doc, "c" | "s") → string`
  - `index.ts`: public re-exports.

- [ ] **Step 1: Add `ParsedDoc` to `src/rfm/types.ts`** (Span/Endmatter already declared above in the same file)

```ts
export interface ParsedDoc {
  body: string;
  endmatterRaw: string | null;
  spans: Span[];
  endmatter: Endmatter;
}
```

- [ ] **Step 2: Write failing test `src/rfm/parse.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parse, nextId } from "./parse.js";

const DOC = `x {==h==}{>>note<<}{#c1} y

---
comments:
  c1:
    by: user
    at: "t"
`;

describe("parse", () => {
  it("returns body, spans and endmatter together", () => {
    const doc = parse(DOC);
    expect(doc.body.startsWith("x {==h==}")).toBe(true);
    expect(doc.spans.map((s) => s.kind)).toEqual(["highlight", "comment"]);
    expect(doc.endmatter.comments.c1).toMatchObject({ by: "user" });
  });

  it("nextId allocates max+1 across inline ids and endmatter", () => {
    const doc = parse(DOC);
    expect(nextId(doc, "c")).toBe("c2");
    expect(nextId(doc, "s")).toBe("s1");
  });

  it("handles a doc with no endmatter", () => {
    const doc = parse("hello {>>q<<}");
    expect(doc.endmatter).toEqual({ comments: {}, suggestions: {} });
    expect(nextId(doc, "c")).toBe("c1");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/rfm/parse.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 4: Write `src/rfm/parse.ts`**

```ts
import { splitEndmatter, parseEndmatter } from "./endmatter.js";
import { tokenize } from "./tokenize.js";
import type { ParsedDoc } from "./types.js";

export function parse(md: string): ParsedDoc {
  const { body, endmatterRaw } = splitEndmatter(md);
  const spans = tokenize(body);
  const endmatter = parseEndmatter(endmatterRaw);
  return { body, endmatterRaw, spans, endmatter };
}

export function nextId(doc: ParsedDoc, prefix: "c" | "s"): string {
  const seen = new Set<string>();
  for (const s of doc.spans) if (s.id) seen.add(s.id);
  for (const id of Object.keys(doc.endmatter.comments)) seen.add(id);
  for (const id of Object.keys(doc.endmatter.suggestions)) seen.add(id);
  let max = 0;
  for (const id of seen) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}
```

- [ ] **Step 5: Write `src/rfm/index.ts`**

```ts
export * from "./types.js";
export { parse, nextId } from "./parse.js";
export { tokenize } from "./tokenize.js";
export { splitEndmatter, parseEndmatter, serializeEndmatter } from "./endmatter.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/rfm/parse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/rfm/parse.ts src/rfm/parse.test.ts src/rfm/index.ts src/rfm/types.ts
git commit -m "✨ feat(rfm): parse() model and id allocation"
```

---

## Task 5: rfm — insertComment / addReply / setResolved

**Files:**
- Create: `src/rfm/insert.ts`, `src/rfm/insert.test.ts`
- Modify: `src/rfm/index.ts`

**Interfaces:**
- Consumes: `parse`, `nextId` (Task 4); `serializeEndmatter` (Task 2).
- Produces (all offsets are **body-relative**):
  - `insertComment(md, range:[number,number], commentBody, author, at) → { md; id }`
  - `addReply(md, parentId, replyBody, author, at) → { md; id }`
  - `setResolved(md, id, resolved) → md`
  - All reject (throw `Error`) if `commentBody`/selection contains a CriticMarkup closer sequence that would corrupt parsing (see Step 5).

- [ ] **Step 1: Write failing test `src/rfm/insert.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { insertComment, addReply, setResolved } from "./insert.js";
import { parse } from "./parse.js";

describe("insertComment", () => {
  it("wraps the selected body range and records endmatter", () => {
    const { md: out, id } = insertComment("Hello world\n", [6, 11], "why?", "user", "t");
    expect(id).toBe("c1");
    expect(out).toContain("Hello {==world==}{>>why?<<}{#c1}");
    expect(parse(out).endmatter.comments.c1).toEqual({ by: "user", at: "t", resolved: false });
  });

  it("allocates a fresh id when one already exists", () => {
    const md = "a {==x==}{>>n<<}{#c1} b\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n";
    expect(insertComment(md, [0, 1], "second", "AI", "t2").id).toBe("c2");
  });

  it("rejects a comment body containing a closer sequence", () => {
    expect(() => insertComment("hi\n", [0, 2], "bad <<} body", "user", "t")).toThrow();
  });
});

describe("addReply / setResolved", () => {
  const base = "x {==y==}{>>q<<}{#c1} z\n\n---\ncomments:\n  c1:\n    by: user\n    at: t\n";

  it("adds a reply as a new id with re", () => {
    const { md, id } = addReply(base, "c1", "answer", "AI", "t2");
    expect(id).toBe("c2");
    expect(parse(md).endmatter.comments.c2).toEqual({ by: "AI", at: "t2", re: "c1", body: "answer" });
  });

  it("marks a thread resolved", () => {
    expect(parse(setResolved(base, "c1", true)).endmatter.comments.c1.resolved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/rfm/insert.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `src/rfm/insert.ts`**

```ts
import { parse, nextId } from "./parse.js";
import { serializeEndmatter } from "./endmatter.js";
import type { Endmatter } from "./types.js";

const CLOSERS = ["<<}", "==}", "++}", "--}", "~~}"];

function assertSafe(text: string, label: string): void {
  for (const c of CLOSERS) {
    if (text.includes(c)) throw new Error(`${label} may not contain "${c}"`);
  }
}

function rebuild(body: string, endmatter: Endmatter): string {
  const trimmedBody = body.replace(/\n+$/, "\n");
  const serialized = serializeEndmatter(endmatter);
  return serialized ? `${trimmedBody}\n---\n${serialized}` : trimmedBody;
}

export function insertComment(
  md: string,
  range: [number, number],
  commentBody: string,
  author: string,
  at: string,
): { md: string; id: string } {
  const doc = parse(md);
  const [start, end] = range;
  const selected = doc.body.slice(start, end);
  assertSafe(selected, "selection");
  assertSafe(commentBody, "comment");
  const id = nextId(doc, "c");
  const wrapped = `{==${selected}==}{>>${commentBody}<<}{#${id}}`;
  const newBody = doc.body.slice(0, start) + wrapped + doc.body.slice(end);
  doc.endmatter.comments[id] = { by: author, at, resolved: false };
  return { md: rebuild(newBody, doc.endmatter), id };
}

export function addReply(
  md: string,
  parentId: string,
  replyBody: string,
  author: string,
  at: string,
): { md: string; id: string } {
  assertSafe(replyBody, "reply");
  const doc = parse(md);
  const id = nextId(doc, "c");
  doc.endmatter.comments[id] = { by: author, at, re: parentId, body: replyBody };
  return { md: rebuild(doc.body, doc.endmatter), id };
}

export function setResolved(md: string, id: string, resolved: boolean): string {
  const doc = parse(md);
  const c = doc.endmatter.comments[id];
  if (c) c.resolved = resolved;
  return rebuild(doc.body, doc.endmatter);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/rfm/insert.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Update index + commit**

Add to `src/rfm/index.ts`: `export { insertComment, addReply, setResolved } from "./insert.js";`

```bash
git add src/rfm/insert.ts src/rfm/insert.test.ts src/rfm/index.ts
git commit -m "✨ feat(rfm): insertComment, addReply, setResolved (+closer guard)"
```

---

## Task 6: rfm — applySuggestion()

**Files:**
- Create: `src/rfm/suggest.ts`, `src/rfm/suggest.test.ts`
- Modify: `src/rfm/index.ts`

**Interfaces:**
- Consumes: `parse` (Task 4); `serializeEndmatter` (Task 2).
- Produces: `applySuggestion(md, id, "accept" | "reject") → md` — replaces the matching span with its resolved text (insertion→inner/"", deletion→""/inner, substitution→new/old, highlight/comment→inner) and removes the matching endmatter entry. Empty endmatter drops the `---` block (relies on Task 2's `serializeEndmatter` returning `""`).

- [ ] **Step 1: Write failing test `src/rfm/suggest.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { applySuggestion } from "./suggest.js";

const sub = "say {~~old~>new~~}{#s1} now\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: t\n";

describe("applySuggestion", () => {
  it("accept substitution → new text, endmatter dropped entirely", () => {
    const out = applySuggestion(sub, "s1", "accept");
    expect(out).toContain("say new now");
    expect(out).not.toContain("---");
    expect(out).not.toContain("{}");
  });

  it("reject substitution → old text", () => {
    expect(applySuggestion(sub, "s1", "reject")).toContain("say old now");
  });

  it("accept insertion keeps text; reject insertion drops it", () => {
    const ins = "a {++b++}{#s1} c\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: t\n";
    expect(applySuggestion(ins, "s1", "accept")).toContain("a b c");
    expect(applySuggestion(ins, "s1", "reject")).toContain("a  c");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/rfm/suggest.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `src/rfm/suggest.ts`**

```ts
import { parse } from "./parse.js";
import { serializeEndmatter } from "./endmatter.js";
import type { Span } from "./types.js";

function resolvedText(span: Span, action: "accept" | "reject"): string {
  switch (span.kind) {
    case "insertion":
      return action === "accept" ? span.inner : "";
    case "deletion":
      return action === "accept" ? "" : span.inner;
    case "substitution":
      return action === "accept" ? (span.newText ?? "") : (span.oldText ?? "");
    default:
      return span.inner;
  }
}

export function applySuggestion(md: string, id: string, action: "accept" | "reject"): string {
  const doc = parse(md);
  const span = doc.spans.find((s) => s.id === id);
  if (!span) return md;
  const replacement = resolvedText(span, action);
  const newBody = doc.body.slice(0, span.start) + replacement + doc.body.slice(span.end);
  delete doc.endmatter.suggestions[id];
  delete doc.endmatter.comments[id];
  const trimmedBody = newBody.replace(/\n+$/, "\n");
  const serialized = serializeEndmatter(doc.endmatter);
  return serialized ? `${trimmedBody}\n---\n${serialized}` : trimmedBody;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/rfm/suggest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update index + commit**

Add to `src/rfm/index.ts`: `export { applySuggestion } from "./suggest.js";`

```bash
git add src/rfm/suggest.ts src/rfm/suggest.test.ts src/rfm/index.ts
git commit -m "✨ feat(rfm): applySuggestion accept/reject"
```

---

## Task 7: server — version + GET /api/file

**Files:**
- Create: `src/server/version.ts`, `src/server/fileStore.ts`, `src/server/app.ts`, `src/server/app.test.ts`

**Interfaces:**
- Produces:
  - `version.ts`: `computeVersion(content: string): string` (content-only sha256).
  - `fileStore.ts`: `class FileStore { readonly absPath; lastWritten: string | null; read(): Promise<{content; version}>; write(content): Promise<string> }`
  - `app.ts`: `createApp(store: FileStore): Hono` with a Host-guard middleware + `GET /api/file` → `{ content, version }`.

- [ ] **Step 1: Write failing test `src/server/app.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./fileStore.js";
import { createApp } from "./app.js";

let dir: string;
let file: string;
const LOCAL = { headers: { host: "localhost:4747" } };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkmark-"));
  file = join(dir, "doc.md");
  await writeFile(file, "Hello\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/file", () => {
  it("returns content and a version", async () => {
    const app = createApp(new FileStore(file));
    const res = await app.request("/api/file", LOCAL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; version: string };
    expect(body.content).toBe("Hello\n");
    expect(body.version).toMatch(/.+/);
  });

  it("rejects a non-localhost Host header", async () => {
    const app = createApp(new FileStore(file));
    const res = await app.request("/api/file", { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: FAIL (cannot find modules).

- [ ] **Step 3: Write `src/server/version.ts`**

```ts
import { createHash } from "node:crypto";

export function computeVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Write `src/server/fileStore.ts`**

```ts
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeVersion } from "./version.js";

export class FileStore {
  lastWritten: string | null = null;
  constructor(public readonly absPath: string) {}

  async read(): Promise<{ content: string; version: string }> {
    const content = await readFile(this.absPath, "utf8");
    return { content, version: computeVersion(content) };
  }

  /** Atomic write via temp file + rename. Returns the new version. */
  async write(content: string): Promise<string> {
    const tmp = join(dirname(this.absPath), `.inkmark-${process.pid}.tmp`);
    await writeFile(tmp, content, "utf8");
    await rename(tmp, this.absPath);
    const version = computeVersion(content);
    this.lastWritten = version;
    return version;
  }
}
```

- [ ] **Step 5: Write `src/server/app.ts`**

```ts
import { Hono } from "hono";
import type { FileStore } from "./fileStore.js";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp(store: FileStore): Hono {
  const app = new Hono();

  // DNS-rebinding guard: only accept requests addressed to localhost.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!LOCAL_HOST.test(host)) return c.text("forbidden", 403);
    return next();
  });

  app.get("/api/file", async (c) => {
    try {
      const { content, version } = await store.read();
      return c.json({ content, version });
    } catch (err) {
      console.error("read failed:", err);
      return c.json({ error: "read failed" }, 500);
    }
  });

  return app;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/server/version.ts src/server/fileStore.ts src/server/app.ts src/server/app.test.ts
git commit -m "✨ feat(server): file store + GET /api/file + host guard"
```

---

## Task 8: server — PUT /api/file with 409 conflict

**Files:**
- Modify: `src/server/app.ts`, `src/server/app.test.ts`

**Interfaces:**
- Produces: `PUT /api/file` accepts `{ content; baseVersion }`; returns `200 { version }`, `409 { error, version }` on version mismatch, `403` on write-permission errors, `400` on bad input. (Host guard already applies to all routes.)

- [ ] **Step 1: Add failing tests to `src/server/app.test.ts`**

```ts
describe("PUT /api/file", () => {
  it("writes when baseVersion matches and returns a new version", async () => {
    const store = new FileStore(file);
    const app = createApp(store);
    const { version } = await store.read();
    const res = await app.request("/api/file", {
      method: "PUT",
      headers: { host: "localhost:4747", "content-type": "application/json" },
      body: JSON.stringify({ content: "Changed\n", baseVersion: version }),
    });
    expect(res.status).toBe(200);
    expect((await store.read()).content).toBe("Changed\n");
  });

  it("rejects with 409 on version mismatch and returns the current version", async () => {
    const app = createApp(new FileStore(file));
    const res = await app.request("/api/file", {
      method: "PUT",
      headers: { host: "localhost:4747", "content-type": "application/json" },
      body: JSON.stringify({ content: "x", baseVersion: "stale" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).version).toMatch(/.+/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: FAIL (route 404 / wrong status).

- [ ] **Step 3: Add the PUT route to `src/server/app.ts`** (inside `createApp`, before `return app`)

```ts
  app.put("/api/file", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; baseVersion?: string }
      | null;
    if (!body || typeof body.content !== "string" || typeof body.baseVersion !== "string") {
      return c.json({ error: "content and baseVersion required" }, 400);
    }
    const current = await store.read();
    if (current.version !== body.baseVersion) {
      return c.json({ error: "version conflict", version: current.version }, 409);
    }
    try {
      const version = await store.write(body.content);
      return c.json({ version });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") return c.json({ error: "permission denied" }, 403);
      console.error("write failed:", err);
      return c.json({ error: "write failed" }, 500);
    }
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/app.test.ts
git commit -m "✨ feat(server): PUT /api/file with 409 + 403 handling"
```

---

## Task 9: server — directory watch + SSE /api/events

**Files:**
- Create: `src/server/watch.ts`, `src/server/watch.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces:
  - `watch.ts`: `class FileWatcher { constructor(store); start(); onChange(cb:(version:string)=>void): ()=>void; close(): Promise<void> }` — watches the **containing directory** (filtered to the target filename) so it survives atomic renames; suppresses changes whose version equals `store.lastWritten` (self-echo).
  - `app.ts`: `createApp(store, watcher?)` adds `GET /api/events` (SSE) emitting `data: {"version":"..."}`.

- [ ] **Step 1: Write failing test `src/server/watch.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./fileStore.js";
import { FileWatcher } from "./watch.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkmark-w-"));
  file = join(dir, "doc.md");
  await writeFile(file, "one\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function nextChange(w: FileWatcher, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const off = w.onChange((v) => {
      off();
      resolve(v);
    });
    setTimeout(() => {
      off();
      reject(new Error("no change event"));
    }, ms);
  });
}

describe("FileWatcher", () => {
  it("emits a new version when the file changes externally", async () => {
    const store = new FileStore(file);
    const watcher = new FileWatcher(store);
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    const got = nextChange(watcher);
    await writeFile(file, "two\n");
    expect(await got).toMatch(/.+/);
    await watcher.close();
  });

  it("survives an atomic rename and still reports the next external write", async () => {
    const store = new FileStore(file);
    const watcher = new FileWatcher(store);
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    await store.write("via-store\n"); // atomic rename + sets lastWritten (self-echo, suppressed)
    await new Promise((r) => setTimeout(r, 200));
    const got = nextChange(watcher);
    await writeFile(file, "external-after-rename\n");
    expect(await got).toMatch(/.+/);
    await watcher.close();
  });

  it("suppresses self-write echo", async () => {
    const store = new FileStore(file);
    const watcher = new FileWatcher(store);
    let calls = 0;
    watcher.onChange(() => calls++);
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    await store.write("self\n");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(0);
    await watcher.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/server/watch.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `src/server/watch.ts`** (watch the directory, filter the filename)

```ts
import chokidar, { type FSWatcher } from "chokidar";
import { dirname, basename, join } from "node:path";
import type { FileStore } from "./fileStore.js";

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private listeners = new Set<(version: string) => void>();
  constructor(private store: FileStore) {}

  start(): void {
    const dir = dirname(this.store.absPath);
    const name = basename(this.store.absPath);
    // Watch the directory (depth 0) so a save-by-rename does not break the watch.
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    });
    const handler = async (changedPath: string) => {
      if (basename(changedPath) !== name) return;
      try {
        const { version } = await this.store.read();
        if (version === this.store.lastWritten) return; // self-echo
        for (const cb of this.listeners) cb(version);
      } catch {
        /* file briefly missing during rename; ignore */
      }
    };
    this.watcher.on("add", handler).on("change", handler);
    void join; // (no-op import guard; join available if needed)
  }

  onChange(cb: (version: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.listeners.clear();
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/server/watch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add SSE route to `src/server/app.ts`**

Change signature to `export function createApp(store: FileStore, watcher?: FileWatcher): Hono` and add imports:

```ts
import { streamSSE } from "hono/streaming";
import type { FileWatcher } from "./watch.js";
```

Inside `createApp`, before `return app` (after the API routes):

```ts
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      if (!watcher) return;
      let alive = true;
      const off = watcher.onChange((version) => {
        if (alive) void stream.writeSSE({ data: JSON.stringify({ version }) });
      });
      stream.onAbort(() => {
        alive = false;
        off();
      });
      while (alive) await stream.sleep(30_000);
    });
  });
```

- [ ] **Step 6: Run all server tests + commit**

Run: `pnpm vitest run src/server` → Expected: PASS.

```bash
git add src/server/watch.ts src/server/watch.test.ts src/server/app.ts
git commit -m "✨ feat(server): directory-scoped watcher + SSE /api/events"
```

---

## Task 10: server — static SPA serving + start()

**Files:**
- Create: `src/server/start.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces:
  - `app.ts`: serve the built SPA from an **absolute** `dist/web` path (resolved from `import.meta.url`, not cwd), with SPA fallback to `index.html`.
  - `start.ts`: `startServer(absPath, port) → Promise<{ url; port; close }>` — wires store + watcher + app, serves via `@hono/node-server` **bound to `127.0.0.1`**.

- [ ] **Step 1: Add static serving to `src/server/app.ts`**

Add import and, after the API routes, before `return app`:

```ts
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
```

```ts
  // Absolute path to the bundled SPA: dist/web sits next to dist/server at runtime.
  const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("/*", serveStatic({ path: `${webRoot}index.html` }));
```

> `import.meta.url` at runtime is `…/dist/server/app.js`; `../web/` → `…/dist/web/`. This is cwd-independent, so `npx inkmark` from any directory finds the assets. (Not unit-tested — depends on built assets; covered by Task 15.)

- [ ] **Step 2: Write `src/server/start.ts`**

```ts
import { serve } from "@hono/node-server";
import { FileStore } from "./fileStore.js";
import { FileWatcher } from "./watch.js";
import { createApp } from "./app.js";

export async function startServer(
  absPath: string,
  port: number,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const store = new FileStore(absPath);
  const watcher = new FileWatcher(store);
  watcher.start();
  const app = createApp(store, watcher);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  const url = `http://localhost:${port}`;
  return {
    url,
    port,
    close: async () => {
      await watcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add src/server/app.ts src/server/start.ts
git commit -m "✨ feat(server): loopback bind + absolute static SPA serving"
```

---

## Task 11: cli — open / status / stop

**Files:**
- Create: `src/cli/port.ts`, `src/cli/port.test.ts`, `src/cli/index.ts`, `bin/inkmark`

**Interfaces:**
- Consumes: `startServer` (Task 10).
- Produces:
  - `port.ts`: `findFreePort(preferred: number): Promise<number>` (probes `127.0.0.1`).
  - `index.ts`: `main(argv): Promise<number>` — `open <file>` validates `.md`+existence, starts the server, opens the browser, stays alive; `status`/`stop` use a state file at `~/.inkmark/server.json`.
  - `bin/inkmark`: launches `dist/cli/index.js`.

- [ ] **Step 1: Write failing test `src/cli/port.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { findFreePort } from "./port.js";

describe("findFreePort", () => {
  it("returns the preferred port when free", async () => {
    const p = await findFreePort(4747);
    expect(p).toBeGreaterThan(0);
  });

  it("falls through when the preferred port is taken", async () => {
    const taken = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const addr = s.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const p = await findFreePort(taken);
    expect(p).not.toBe(taken);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/cli/port.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `src/cli/port.ts`**

```ts
import { createServer } from "node:net";

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    if (await isFree(p)) return p;
  }
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : preferred;
      srv.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/cli/port.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `src/cli/index.ts`**

```ts
import { resolve, join } from "node:path";
import { stat, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import open from "open";
import { findFreePort } from "./port.js";
import { startServer } from "../server/start.js";

const STATE = join(homedir(), ".inkmark", "server.json");
const DEFAULT_PORT = 4747;

async function cmdOpen(fileArg: string | undefined): Promise<number> {
  if (!fileArg) {
    console.error("usage: inkmark open <file.md>");
    return 2;
  }
  const absPath = resolve(process.cwd(), fileArg);
  if (!absPath.endsWith(".md")) {
    console.error(`not a markdown file: ${absPath}`);
    return 2;
  }
  try {
    await stat(absPath);
  } catch {
    console.error(`file not found: ${absPath}`);
    return 2;
  }
  const port = await findFreePort(DEFAULT_PORT);
  const server = await startServer(absPath, port);
  await mkdir(join(homedir(), ".inkmark"), { recursive: true });
  await writeFile(STATE, JSON.stringify({ url: server.url, port, pid: process.pid, file: absPath }));
  console.log(`inkmark serving ${absPath}\n  ${server.url}`);
  await open(server.url);
  const shutdown = async () => {
    await server.close();
    await rm(STATE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // stay alive
  return 0;
}

async function cmdStatus(): Promise<number> {
  try {
    const s = JSON.parse(await readFile(STATE, "utf8"));
    console.log(`running: ${s.url} (pid ${s.pid}, file ${s.file})`);
  } catch {
    console.log("not running");
  }
  return 0;
}

async function cmdStop(): Promise<number> {
  try {
    const s = JSON.parse(await readFile(STATE, "utf8"));
    process.kill(s.pid, "SIGTERM");
    console.log("stopped");
  } catch {
    console.log("not running");
  }
  await rm(STATE, { force: true });
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "open":
      return cmdOpen(arg);
    case "status":
      return cmdStatus();
    case "stop":
      return cmdStop();
    default:
      console.error("usage: inkmark <open|status|stop> [file.md]");
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exit(code);
});
```

> Note: the served URL is the bare origin — no `?file=` query. The opened file is fixed by `FileStore` at start; request input never selects a path.

- [ ] **Step 6: Write `bin/inkmark`** then `chmod +x bin/inkmark`

```js
#!/usr/bin/env node
import("../dist/cli/index.js");
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/port.ts src/cli/port.test.ts src/cli/index.ts bin/inkmark
git commit -m "✨ feat(cli): open/status/stop on loopback (no ?file= input)"
```

---

## Task 12: web — app shell, body render, SSE live reload, theme

**Files:**
- Create: `src/web/index.html`, `src/web/main.tsx`, `src/web/theme.css`, `src/web/api.ts`, `src/web/App.tsx`, `src/web/MarkdownView.tsx`, `vite.config.ts`, `src/web/App.test.tsx`

**Interfaces:**
- Produces:
  - `api.ts`: `getFile()`, `putFile(content, baseVersion)`, `subscribe(onVersion)`.
  - `MarkdownView.tsx`: `MarkdownView({ source }: { source: string }): React.JSX.Element` — renders **GFM** of the given source (caller passes `parse(content).body`).
  - `App.tsx`: fetches the file, renders only the body, refetches on SSE.

- [ ] **Step 1: Write `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:4747" } },
});
```

- [ ] **Step 2: Write `src/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>inkmark</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Write `src/web/theme.css`**

```css
@import "github-markdown-css/github-markdown.css";

:root { color-scheme: light dark; }
body { margin: 0; font-family: system-ui, sans-serif; }
.layout { display: grid; grid-template-columns: 1fr 320px; gap: 0; height: 100vh; }
.markdown-body { padding: 2rem 3rem; overflow: auto; }

mark[data-cm-kind] { border-radius: 2px; padding: 0 1px; }
mark[data-cm-kind="highlight"],
mark[data-cm-kind="comment"] { background: #fff3a3; }
mark[data-cm-kind="insertion"] { background: #c8f0c8; text-decoration: none; }
mark[data-cm-kind="deletion"] { background: #f6c6c6; text-decoration: line-through; }

.comment-sidebar { border-left: 1px solid #ddd; padding: 1rem; overflow: auto; background: #fafafa; }
.thread { border: 1px solid #e2e2e2; border-radius: 6px; padding: .5rem; margin-bottom: .75rem; background: #fff; }
.thread.resolved { opacity: .5; }
.reply { margin-left: 1rem; color: #444; }
.reply-box { display: flex; gap: .25rem; margin-top: .5rem; }
.reply-box input { flex: 1; }
.suggestion { border-left: 3px solid #6aa; padding-left: .5rem; margin-bottom: .75rem; }
.selection-popover { background: #222; color: #fff; border-radius: 4px; padding: .25rem .5rem; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
.selection-popover button { background: none; border: none; color: inherit; cursor: pointer; }
```

- [ ] **Step 4: Write `src/web/api.ts`**

```ts
export async function getFile(): Promise<{ content: string; version: string }> {
  const res = await fetch("/api/file");
  if (!res.ok) throw new Error(`getFile ${res.status}`);
  return res.json();
}

export async function putFile(
  content: string,
  baseVersion: string,
): Promise<{ ok: true; version: string } | { ok: false; status: number; version?: string }> {
  const res = await fetch("/api/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, baseVersion }),
  });
  if (res.ok) return { ok: true, version: (await res.json()).version };
  const body = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, version: body.version };
}

export function subscribe(onVersion: (v: string) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      onVersion(JSON.parse(e.data).version);
    } catch {
      /* ignore malformed */
    }
  };
  return () => es.close();
}
```

- [ ] **Step 5: Write `src/web/MarkdownView.tsx`** (GFM of supplied body only)

```tsx
import type { JSX } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownView({ source }: { source: string }): JSX.Element {
  return (
    <article className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </article>
  );
}
```

- [ ] **Step 6: Write `src/web/App.tsx`** (render body, not the full file)

```tsx
import { useEffect, useRef, useState, type JSX } from "react";
import { getFile, subscribe } from "./api.js";
import { parse } from "../rfm/index.js";
import { MarkdownView } from "./MarkdownView.js";

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const version = useRef("");

  async function refresh() {
    const r = await getFile();
    setContent(r.content);
    version.current = r.version;
  }

  useEffect(() => {
    void refresh();
    return subscribe(() => void refresh());
  }, []);

  if (content === null) return <div>Loading…</div>;
  const body = parse(content).body;
  return (
    <div className="layout">
      <MarkdownView source={body} />
    </div>
  );
}
```

- [ ] **Step 7: Write `src/web/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Write component test `src/web/App.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownView } from "./MarkdownView.js";

describe("MarkdownView", () => {
  it("renders GFM headings and lists", () => {
    render(<MarkdownView source={"# Title\n\n- a\n- b\n"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
```

- [ ] **Step 9: Run web test + typecheck:web + build**

Run: `pnpm vitest run src/web/App.test.tsx` → PASS.
Run: `pnpm typecheck:web` → clean (verifies the `../rfm/*.js` import + JSX types resolve).
Run: `pnpm build:web` → builds to `dist/web`.

- [ ] **Step 10: Commit**

```bash
git add vite.config.ts src/web/index.html src/web/main.tsx src/web/theme.css src/web/api.ts src/web/App.tsx src/web/MarkdownView.tsx src/web/App.test.tsx
git commit -m "✨ feat(web): app shell, body rendering, theme, SSE live reload"
```

---

## Task 13: web — CriticMarkup rendering + comment/suggestion sidebar

**Files:**
- Create: `src/web/remarkCriticmarkup.ts`, `src/web/remarkCriticmarkup.test.ts`, `src/web/CommentSidebar.tsx`
- Modify: `src/web/MarkdownView.tsx`, `src/web/App.tsx`

**Interfaces:**
- Produces:
  - `remarkCriticmarkup.ts`: a remark plugin that splits text nodes containing CriticMarkup into `<mark data-cm-kind data-cm-id>` **with their inner text preserved** (via `hChildren`). Substitution is skipped (GFM consumed `~~`).
  - `CommentSidebar.tsx`: `CommentSidebar({ source, onReply, onResolve, onSuggestion }): JSX.Element` — lists comment threads (root inline body + `re` replies, reply box, resolve) **and** suggestions (Accept/Reject).

- [ ] **Step 1: Write failing test `src/web/remarkCriticmarkup.test.ts`** (asserts inner text survives — guards the empty-mark bug)

```ts
import { describe, it, expect } from "vitest";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { remarkCriticmarkup } from "./remarkCriticmarkup.js";

async function toHtml(src: string): Promise<string> {
  const file = await remark()
    .use(remarkGfm)
    .use(remarkCriticmarkup)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(src);
  return String(file);
}

describe("remarkCriticmarkup", () => {
  it("wraps a comment span in a mark with data attributes AND keeps inner text", async () => {
    const html = await toHtml("a {==x==}{>>note<<}{#c1} b");
    expect(html).toContain('data-cm-kind="highlight"');
    expect(html).toContain('data-cm-id="c1"');
    expect(html).toMatch(/<mark[^>]*>x<\/mark>/); // inner text must survive
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/web/remarkCriticmarkup.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `src/web/remarkCriticmarkup.ts`** (carry text via `hChildren`)

```ts
import { visit } from "unist-util-visit";
import type { Root, Text, PhrasingContent } from "mdast";
import { tokenize } from "../rfm/tokenize.js";

export function remarkCriticmarkup() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const spans = tokenize(node.value);
      if (spans.length === 0) return;

      const out: PhrasingContent[] = [];
      let cursor = 0;
      for (const span of spans) {
        if (span.kind === "substitution") continue; // collides with GFM strikethrough; not rendered in v1
        if (span.start > cursor) out.push({ type: "text", value: node.value.slice(cursor, span.start) });
        const display = span.inner;
        // Emit a node whose hast form is <mark ...>display</mark>. hChildren preserves
        // the inner text (a bare hName on a text node would drop the value).
        out.push({
          type: "text",
          value: display,
          data: {
            hName: "mark",
            hProperties: { "data-cm-kind": span.kind, ...(span.id ? { "data-cm-id": span.id } : {}) },
            hChildren: [{ type: "text", value: display }],
          },
        } as unknown as PhrasingContent);
        cursor = span.end;
      }
      if (cursor < node.value.length) out.push({ type: "text", value: node.value.slice(cursor) });
      if (out.length === 0) return;
      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/web/remarkCriticmarkup.test.ts`
Expected: PASS (inner text present).

- [ ] **Step 5: Wire the plugin into `src/web/MarkdownView.tsx`**

```tsx
import type { JSX } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCriticmarkup } from "./remarkCriticmarkup.js";

export function MarkdownView({ source }: { source: string }): JSX.Element {
  return (
    <article className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm, remarkCriticmarkup]}>{source}</Markdown>
    </article>
  );
}
```

- [ ] **Step 6: Write `src/web/CommentSidebar.tsx`** (threads + suggestions)

```tsx
import { useState, type JSX } from "react";
import { parse } from "../rfm/index.js";

interface SidebarProps {
  source: string;
  onReply: (parentId: string, body: string) => void;
  onResolve: (id: string) => void;
  onSuggestion: (id: string, action: "accept" | "reject") => void;
}

export function CommentSidebar({ source, onReply, onResolve, onSuggestion }: SidebarProps): JSX.Element {
  const doc = parse(source);
  const comments = doc.endmatter.comments;
  const roots = Object.entries(comments).filter(([, c]) => !c.re);
  const inlineBody = (id: string) =>
    doc.spans.find((s) => s.id === id && s.kind === "comment")?.inner ?? "";
  const suggestionIds = Array.from(
    new Set([
      ...Object.keys(doc.endmatter.suggestions),
      ...doc.spans.filter((s) => s.id?.startsWith("s")).map((s) => s.id as string),
    ]),
  );

  return (
    <aside className="comment-sidebar">
      {roots.map(([id, c]) => {
        const replies = Object.entries(comments).filter(([, r]) => r.re === id);
        return (
          <div key={id} className={c.resolved ? "thread resolved" : "thread"}>
            <div className="comment">
              <b>{c.by}</b>: {inlineBody(id)}
            </div>
            {replies.map(([rid, r]) => (
              <div className="reply" key={rid}>
                <b>{r.by}</b>: {r.body}
              </div>
            ))}
            <ReplyBox onSend={(body) => onReply(id, body)} />
            {!c.resolved && <button onClick={() => onResolve(id)}>Resolve</button>}
          </div>
        );
      })}
      {suggestionIds.map((id) => {
        const span = doc.spans.find((s) => s.id === id);
        const label =
          span?.kind === "substitution"
            ? `${span.oldText} → ${span.newText}`
            : span?.kind === "insertion"
              ? `+ ${span.inner}`
              : span?.kind === "deletion"
                ? `- ${span.inner}`
                : id;
        return (
          <div className="suggestion" key={id}>
            <div>{label}</div>
            <button onClick={() => onSuggestion(id, "accept")}>Accept</button>
            <button onClick={() => onSuggestion(id, "reject")}>Reject</button>
          </div>
        );
      })}
    </aside>
  );
}

function ReplyBox({ onSend }: { onSend: (body: string) => void }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <div className="reply-box">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
      <button
        onClick={() => {
          if (text.trim()) onSend(text.trim());
          setText("");
        }}
      >
        Send
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Wire sidebar + pure-transform save (with 409 re-apply) into `src/web/App.tsx`**

```tsx
import { useEffect, useRef, useState, type JSX } from "react";
import { getFile, putFile, subscribe } from "./api.js";
import { parse, addReply, setResolved, applySuggestion } from "../rfm/index.js";
import { MarkdownView } from "./MarkdownView.js";
import { CommentSidebar } from "./CommentSidebar.js";

export function App(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const version = useRef("");

  async function refresh() {
    const r = await getFile();
    setContent(r.content);
    version.current = r.version;
  }

  // Apply a pure (content) -> content transform, re-applying against fresh
  // content on a 409 (Success Criterion #5: re-apply, not just reload).
  async function save(transform: (src: string) => string) {
    let base = content ?? "";
    let baseVersion = version.current;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = transform(base);
      const res = await putFile(next, baseVersion);
      if (res.ok) {
        version.current = res.version;
        setContent(next);
        return;
      }
      if (res.status === 409) {
        const fresh = await getFile(); // someone (AI) wrote concurrently
        base = fresh.content;
        baseVersion = fresh.version;
        continue; // recompute the transform against the new content
      }
      alert(`save failed (${res.status})`);
      return;
    }
    alert("save failed after retries (conflicts)");
  }

  useEffect(() => {
    void refresh();
    return subscribe(() => void refresh());
  }, []);

  if (content === null) return <div>Loading…</div>;
  const now = new Date().toISOString();
  return (
    <div className="layout">
      <MarkdownView source={parse(content).body} />
      <CommentSidebar
        source={content}
        onReply={(pid, body) => void save((src) => addReply(src, pid, body, "user", now).md)}
        onResolve={(id) => void save((src) => setResolved(src, id, true))}
        onSuggestion={(id, action) => void save((src) => applySuggestion(src, id, action))}
      />
    </div>
  );
}
```

- [ ] **Step 8: Run web tests + typecheck:web + build + commit**

Run: `pnpm vitest run src/web` → PASS.
Run: `pnpm typecheck:web` → clean.
Run: `pnpm build:web` → clean.

```bash
git add src/web/remarkCriticmarkup.ts src/web/remarkCriticmarkup.test.ts src/web/CommentSidebar.tsx src/web/MarkdownView.tsx src/web/App.tsx
git commit -m "✨ feat(web): CriticMarkup rendering + comment/suggestion sidebar (409 re-apply)"
```

---

## Task 14: web — selection → comment via per-text-node source offsets

**Files:**
- Create: `src/web/rehypeSourceSpans.ts`, `src/web/sourceOffset.ts`, `src/web/sourceOffset.test.ts`, `src/web/SelectionPopover.tsx`
- Modify: `src/web/MarkdownView.tsx`, `src/web/App.tsx`

**Interfaces:**
- Consumes: `insertComment` (Task 5).
- Produces:
  - `rehypeSourceSpans.ts`: `rehypeSourceSpans()` — wraps each **source** text node (one carrying `position` offsets) in `<span data-src-start data-src-end>`. Because a leaf text node contains no markdown syntax, its rendered text maps 1:1 to its source slice.
  - `sourceOffset.ts`: `resolveSelectionRange(sel, body): { start: number; end: number } | null` — requires the selection's start and end to lie in **the same** source span, computes body offsets, and returns `null` unless `body.slice(start,end) === sel.toString()` (verification guard).
  - `SelectionPopover.tsx`: `SelectionPopover({ body, onComment }): JSX.Element | null`.

- [ ] **Step 1: Write failing test `src/web/sourceOffset.test.ts`** (real DOM via jsdom)

```ts
import { describe, it, expect } from "vitest";
import { resolveSelectionRange } from "./sourceOffset.js";

function selectWithin(el: Node, start: number, end: number): Selection {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(el.firstChild!, start);
  range.setEnd(el.firstChild!, end);
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("resolveSelectionRange", () => {
  it("maps a selection inside one source span to body offsets", () => {
    document.body.innerHTML =
      '<p><span data-src-start="0" data-src-end="11">Hello world</span></p>';
    const span = document.querySelector("span")!;
    const sel = selectWithin(span, 6, 11); // "world"
    const body = "Hello world\n";
    expect(resolveSelectionRange(sel, body)).toEqual({ start: 6, end: 11 });
  });

  it("returns null when the slice does not round-trip (verification guard)", () => {
    document.body.innerHTML =
      '<p><span data-src-start="0" data-src-end="3">abc</span></p>';
    const span = document.querySelector("span")!;
    const sel = selectWithin(span, 0, 3);
    const body = "XYZdifferent\n"; // body[0,3) !== "abc"
    expect(resolveSelectionRange(sel, body)).toBeNull();
  });

  it("returns null when selection spans two source spans", () => {
    document.body.innerHTML =
      '<p><span data-src-start="0" data-src-end="2">ab</span>' +
      '<span data-src-start="2" data-src-end="4">cd</span></p>';
    const spans = document.querySelectorAll("span");
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(spans[0]!.firstChild!, 0);
    range.setEnd(spans[1]!.firstChild!, 2);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(resolveSelectionRange(sel, "abcd\n")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/web/sourceOffset.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `src/web/rehypeSourceSpans.ts`**

```ts
import { visit } from "unist-util-visit";
import type { Root, Element, Text } from "hast";

/** Wrap each source text node in a <span> carrying its body offset range. */
export function rehypeSourceSpans() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const pos = node.position;
      if (pos?.start?.offset == null || pos?.end?.offset == null) return; // synthetic (e.g. mark children)
      const span: Element = {
        type: "element",
        tagName: "span",
        properties: { dataSrcStart: pos.start.offset, dataSrcEnd: pos.end.offset },
        children: [node],
      };
      (parent.children as Array<Element | Text>)[index] = span;
    });
  };
}
```

- [ ] **Step 4: Write `src/web/sourceOffset.ts`**

```ts
function annotatedAncestor(node: Node | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && el.dataset.srcStart === undefined) el = el.parentElement;
  return el;
}

export function resolveSelectionRange(
  sel: Selection,
  body: string,
): { start: number; end: number } | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = annotatedAncestor(range.startContainer);
  const endEl = annotatedAncestor(range.endContainer);
  if (!startEl || !endEl || startEl !== endEl) return null; // v1: one source run only

  const base = Number(startEl.dataset.srcStart);
  const pre = document.createRange();
  pre.selectNodeContents(startEl);
  pre.setEnd(range.startContainer, range.startOffset);
  const startText = pre.toString().length;
  const len = range.toString().length;
  const start = base + startText;
  const end = start + len;

  // Verification: the computed source slice must equal the selected text.
  if (body.slice(start, end) !== sel.toString()) return null;
  return { start, end };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/web/sourceOffset.test.ts`
Expected: PASS (3 tests, incl. the formatted/guard cases).

- [ ] **Step 6: Add the rehype plugin to `src/web/MarkdownView.tsx`**

```tsx
import type { JSX } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCriticmarkup } from "./remarkCriticmarkup.js";
import { rehypeSourceSpans } from "./rehypeSourceSpans.js";

export function MarkdownView({ source }: { source: string }): JSX.Element {
  return (
    <article className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm, remarkCriticmarkup]} rehypePlugins={[rehypeSourceSpans]}>
        {source}
      </Markdown>
    </article>
  );
}
```

- [ ] **Step 7: Write `src/web/SelectionPopover.tsx`**

```tsx
import { useEffect, useState, type JSX } from "react";
import { resolveSelectionRange } from "./sourceOffset.js";

interface PopoverState {
  x: number;
  y: number;
  range: [number, number];
}

export function SelectionPopover({
  body,
  onComment,
}: {
  body: string;
  onComment: (range: [number, number], commentBody: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<PopoverState | null>(null);

  useEffect(() => {
    function onMouseUp() {
      const sel = window.getSelection();
      if (!sel) return setState(null);
      const r = resolveSelectionRange(sel, body);
      if (!r) return setState(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setState({ x: rect.left, y: rect.bottom + window.scrollY, range: [r.start, r.end] });
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [body]);

  if (!state) return null;
  return (
    <div className="selection-popover" style={{ position: "absolute", left: state.x, top: state.y }}>
      <button
        onClick={() => {
          const commentBody = window.prompt("Comment:");
          if (commentBody && commentBody.trim()) onComment(state.range, commentBody.trim());
          setState(null);
          window.getSelection()?.removeAllRanges();
        }}
      >
        💬 Comment
      </button>
    </div>
  );
}
```

- [ ] **Step 8: Wire popover into `src/web/App.tsx`**

Add `import { SelectionPopover } from "./SelectionPopover.js";` and `import { insertComment } from "../rfm/index.js";` (extend the existing rfm import), then add inside the `<div className="layout">` after `MarkdownView`:

```tsx
      <SelectionPopover
        body={parse(content).body}
        onComment={(range, body) =>
          void save((src) => insertComment(src, range, body, "user", new Date().toISOString()).md)
        }
      />
```

> The popover's `range` is body-relative; `insertComment` expects body-relative offsets; both derive from `parse(content).body`. Consistent.

- [ ] **Step 9: Run all tests + typecheck + full build + commit**

Run: `pnpm test` → all node + web tests PASS.
Run: `pnpm typecheck && pnpm typecheck:web` → clean.
Run: `pnpm build` → server (tsc) + web (vite) build clean.

```bash
git add src/web/rehypeSourceSpans.ts src/web/sourceOffset.ts src/web/sourceOffset.test.ts src/web/SelectionPopover.tsx src/web/MarkdownView.tsx src/web/App.tsx
git commit -m "✨ feat(web): selection → comment via per-text-node source offsets (verified)"
```

---

## Task 15: End-to-end manual verification (success criteria)

**Files:**
- Create: `docs/SMOKE.md`

- [ ] **Step 1: Build and run against a formatted sample (not just plain text)**

```bash
pnpm build
printf '# Demo\n\nA paragraph with **bold** and a [link](https://x) to comment on.\n\nSecond plain paragraph here.\n' > /tmp/inkmark-demo.md
node bin/inkmark open /tmp/inkmark-demo.md
```

Expected: browser opens at the printed `http://localhost:PORT`; heading + both paragraphs render; the YAML endmatter (none yet) is not shown.

- [ ] **Step 2: Verify each success criterion and record in `docs/SMOKE.md`**

```markdown
# Manual smoke test (v1 Done criteria)

1. `node bin/inkmark open /tmp/inkmark-demo.md` renders the file nicely
   (github-markdown theme; endmatter hidden).                            [ ]
2. Select plain text in the SECOND paragraph → 💬 Comment → enter text →
   the `.md` now contains `{==…==}{>>…<<}{#c1}` + a `comments:` endmatter,
   and the highlight shows inline with its text intact.                  [ ]
2b. Select text that crosses **bold**/link → popover does NOT appear
   (single-run constraint + verification guard).                        [ ]
3. Append an AI comment on disk
   (`{>>looks good<<}{#c2}` + endmatter c2) → the viewer updates within a
   few hundred ms (directory watch survived the prior atomic write).     [ ]
4. The AI comment appears as a thread; typing a reply adds a `re:`-linked
   comment to the endmatter.                                             [ ]
5. Add a suggestion on disk (`{++ extra++}{#s1}` + suggestions s1), click
   Accept → text applied, suggestion removed, no stray `---`/`{}`.       [ ]
6. Race: start a comment in the UI while editing the file on disk → the
   409 path re-applies the comment onto the fresh content; no corruption.[ ]
```

- [ ] **Step 3: Commit**

```bash
git add docs/SMOKE.md
git commit -m "📝 docs: manual v1 smoke-test checklist"
```

---

## Self-Review

**Spec coverage:**
- §3 architecture/units → Tasks 2-14 ✓
- §4 data flow + anchoring → Tasks 9 (dir watch + SSE), 12 (SSE client), 14 (per-text-node offsets + verification) ✓
- §5 comment model (inline root + `re` replies, ids, resolve) → Tasks 4, 5, 13 ✓
- §6 conflict handling (content-hash version, 409, atomic write, self-echo, **re-apply**) → Tasks 7, 8, 9, 13 ✓
- §7 error handling (non-.md exit 2, malformed degrade, free port, 403, generic error bodies) → Tasks 11, 2-4, 11, 7/8 ✓
- §8 testing (rfm unit primary, component, integration) → Tasks 2-6, 12-14, 7-9 ✓
- §9 success criteria → Task 15 ✓
- In-v1 "suggestions accept/reject" → Tasks 6 + 13 ✓; "one nice theme" → Task 12 (theme.css) ✓; substitution inline-render deferred (documented in Global Constraints + spec) ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code.

**Type consistency:** `FileStore`(read/write/lastWritten), `computeVersion(content)`, `createApp(store, watcher?)`, `FileWatcher.onChange`, `parse/nextId/insertComment/addReply/setResolved/applySuggestion`, `resolveSelectionRange(sel, body)`, `rehypeSourceSpans`, `remarkCriticmarkup` — names/signatures match across tasks. `resolveSelectionRange` returns `{start,end}`; `SelectionPopover` passes `[start,end]`; `insertComment` takes `[start,end]` body-relative. Consistent.

**Review fixes folded in (from 3-lens review, 2026-06-29):**
- Critical: endmatter newline (T2), empty `<mark>` → `hChildren` (T13), vitest 3 (T1), anchoring per-text-node + verification (T14), substitution/strikethrough collision → deferred render (T13/constraints).
- Important: render body not file (T12/13), suggestions UI (T13), theme CSS (T12), directory watch (T9), web typecheck + `@types/mdast`/`@types/hast` (T1), absolute `serveStatic` root (T10), loopback bind + Host guard (T7/T10), 409 re-apply (T13).
- Suggestions folded: empty-endmatter `{}` drop (T2/T6), closer-sequence guard (T5), content-only version (T7), no `?file=` input (T11), generic error bodies (T7/T8).

**Remaining accepted limitations (documented, not bugs):**
- SSE event replaces in-progress UI state (re-applied transforms make this safe for saves; an unsent reply draft could be lost — acceptable for single-user MVP).
- Inline code spans are not skipped by the web text-visitor the way fenced blocks are server-side; `` `{>>x<<}` `` would render as a mark. Minor; noted for v2.
- SSE route has unit coverage only at the watcher level; the live `streamSSE` path is gated by Task 15 manual test.
