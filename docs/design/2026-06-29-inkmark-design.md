# inkmark — Design (v1)

- **Status**: Approved design, pre-implementation
- **Date**: 2026-06-29
- **Working name**: `inkmark` (changeable; no remote yet)
- **Author**: yoshi47

## 1. Purpose

A local-first Markdown **viewer + commenting** tool that I own. It renders a
single `.md` file beautifully in the browser and lets **both a human and an AI
agent** leave comments and suggested edits on it. Comments live **inside the
Markdown file** as CriticMarkup, so they are git-friendly, portable to other
editors, and readable by an AI agent that simply opens the file.

Motivation: reviewing/iterating on documents with an AI agent is clearer when
feedback is anchored to specific text (Google-Docs/Notion style) than in a chat
back-and-forth. Existing tools each miss something: `mo` / `mdts` are
view-only; `roughdraft` does commenting but its UI is not to my taste. This is
my own take.

## 2. Scope

### Ambition
MVP first → publish to npm as OSS later if it proves useful. Design for clean,
extensible boundaries but do not gold-plate.

### Locked decisions
| Decision | Choice |
|---|---|
| Stack | TypeScript / Node full-stack (Hono server + React/Vite SPA) |
| Architecture | Local server + browser SPA (`npx inkmark open file.md`) |
| Viewing unit (v1) | **Single file** |
| Comment storage | **In-file CriticMarkup** + YAML endmatter |
| AI integration (v1) | **File-only** — the AI reads/writes the `.md` directly |

### In v1
- Render one `.md` (GFM: headings, lists, tables, code, links)
- Render CriticMarkup inline: comment / highlight / insertion / deletion.
  **Substitution** (`{~~old~>new~~}`) is parsed and actionable in the sidebar
  but **not** rendered as an inline mark in v1 — it collides with GFM
  strikethrough (`~~…~~`), so inline rendering is deferred.
- Add comment, reply, resolve (`by: user`)
- Show suggestions and accept/reject them (apply to body or discard)
- Live reflect AI edits (chokidar → SSE)
- One nice built-in theme
- CLI: `inkmark open <file>` / `stop` / `status`

### Not in v1 (later phases)
- Multi-file tree / search
- Mermaid / KaTeX (cheap to add later via rehype; v1 stays plain GFM)
- Blocking "Done Reviewing" handoff / MCP server
- Multi-block or code-spanning range selection for anchoring
- Auth / multiple concurrent human editors (assume a single human)

## 3. Architecture

Single npm package. Vite-built SPA is bundled into `dist/` and served by the
Node (Hono) server. Distribution: `npx inkmark open draft.md` (auto-starts the
server, opens the browser).

```
inkmark/
├─ bin/inkmark            # CLI entry
├─ src/
│  ├─ cli/                # open / stop / status (v1 centers on open)
│  ├─ server/             # Hono server + chokidar watch + file I/O
│  ├─ rfm/                # CriticMarkup parse/serialize/insert (pure functions)
│  └─ web/                # React SPA (Vite)
│     ├─ MarkdownView     # react-markdown + CriticMarkup rendering (highlights)
│     ├─ CommentSidebar   # thread list / reply / resolve
│     └─ SelectionPopover # selection → add comment / suggest edit
└─ dist/                  # build output (server + web bundled)
```

### Units (each understandable & testable in isolation)

| Unit | Responsibility | Depends on | Interface |
|---|---|---|---|
| `rfm` | Parse CriticMarkup + YAML endmatter; serialize back; offset-based insertion; id allocation | none (pure) | `parse(md) → { ast, comments, suggestions }`; `insertComment(md, range, body, id) → md`; `serialize(...)` |
| `server` | Read/write the one opened file; watch for changes → SSE | `rfm`, `chokidar`, `hono` | `GET /api/file`, `PUT /api/file`, `GET /api/events` |
| `web` | Render, select, comment UI | `rfm` (types only), `react-markdown` | HTTP / SSE |
| `cli` | Start server, open browser | `server` | `inkmark open <file>` |

**Design rule:** the hard part of commenting (parsing, anchoring, insertion)
is confined to the pure-function `rfm` module so it can be round-trip tested in
isolation, independent of UI and server.

## 4. Data flow

```
Open:        inkmark open draft.md → server stores absPath, starts → opens browser at localhost:PORT
Render:      SPA → GET /api/file → { content, version, path } → react-markdown + rfm render
Human comment: select text → SelectionPopover → rfm.insertComment(content, range, body)
               → PUT /api/file { content, baseVersion } → server writes file
               → chokidar fires → SSE → SPA refetches (self-write echo ignored)
AI comment:  Claude edits draft.md directly → chokidar fires → SSE → SPA reflects
```

Both human and AI converge on **writing to the `.md` file**. The server is not
involved in the AI's edits — chokidar just notices them. This is what makes
"human and AI comment on the same document" fall out naturally.

### Anchoring (selection → source character range) — the crux

1. **Rendering existing comments:** an `rfm` remark plugin tokenizes
   CriticMarkup so each node carries `position.start/end.offset` (source
   character positions). Rendered as `<mark data-cm-id="c1">`.
2. **Adding a new comment:** each rendered element gets `data-src-start/end`
   (source offsets) from `node.position`. On selection:
   - From `window.getSelection()` anchor/focus nodes, find the nearest ancestor
     element carrying `data-src-*`.
   - Compute the source character range `[start, end)` from that element's
     offset base + the text position within it.
   - `rfm.insertComment(content, [start, end), body, id)` inserts
     `{==selected==}{>>body<<}{#cN}` and appends a YAML endmatter entry.
   - PUT to save.

**v1 anchoring constraint (YAGNI):** selection is limited to a **single block,
contiguous text** (within a paragraph / heading / list item). Code-block-
spanning or multi-block selections are rejected in v1 (the popover shows
"can't comment across this range"). The thorny range cases are deferred.

## 5. Comment model

CriticMarkup in the body + a YAML endmatter block for metadata
(roughdraft-compatible):

```markdown
About {==this part==}{>>What is this?<<}{#c1} in the body.
Suggestion: {~~old wording~>new wording~~}{#s1}

---
comments:
  c1:                   # thread root — its body lives inline in {>>...<<}
    by: user            # or AI
    at: "2026-06-29T..."
    resolved: false
  c2:                   # a reply — no inline marker; body + re live here
    by: AI
    at: "..."
    re: c1
    body: "It means ..."
suggestions:
  s1:
    by: user
    at: "..."
    resolved: false
```

Model (roughdraft-compatible):

- **Thread root** = an inline `{>>body<<}{#c1}`; its `by`/`at`/`resolved`
  metadata lives in the endmatter under `c1`.
- **Reply** = a separate comment id (`c2`) with `body` + `re: c1` in the
  endmatter, and **no inline marker** (it is a response, not an anchor).
- **Id allocation:** `c1, c2…` (comments) / `s1, s2…` (suggestions); `rfm`
  allocates `max+1` across all ids.
- **Resolve:** set `resolved: true` on the thread root. v1 dims the highlight on
  resolve; it does **not** delete the CriticMarkup.
- **Author:** UI writes `by: user`; the AI writes `by: AI` when editing the file
  directly.

## 6. Conflict handling

Because the human and the AI may write concurrently:

- `GET /api/file` returns a `version` (`sha256(content)` — content-only, so it
  is stable across the atomic rename; no mtime component).
- `PUT /api/file` includes `baseVersion`. The server compares against the
  current version and returns **409 Conflict** on mismatch.
- On 409 the SPA **refetches → re-applies its edit onto the new content** and
  re-PUTs. Each human edit is a pure `rfm` transform (`insertComment` /
  `addReply` / `setResolved` / `applySuggestion`), so it is simply recomputed
  against the fresh content (bounded retries).
- Writes are **atomic** (temp file → rename). The directory-scoped chokidar
  watch (so it survives renames) ignores self-echo by comparing against the
  `version` the server just wrote.

## 7. Error handling

| Event | Behavior |
|---|---|
| Path is not `.md` / does not exist | CLI errors and exits (code 2) |
| Malformed CriticMarkup | `rfm` degrades gracefully (render that span as plain text + a warning badge); never crash |
| Port in use | auto-select a free **loopback** port |
| No write permission | PUT returns 403; UI shows a toast (never silent) |
| Internal read/write error | client gets a generic message; details logged server-side (no path leakage) |

**Network safety (local-only tool):** the server binds to **`127.0.0.1`** only —
never `0.0.0.0` — so the file read/write API is not exposed to the LAN. A small
middleware rejects any request whose `Host` header is not `localhost` /
`127.0.0.1` (DNS-rebinding guard), since a file-writing localhost API is
otherwise reachable from a malicious web page. The opened file is fixed at
startup from the CLI argument; request input (e.g. a query param) never selects
a file path. If raw HTML / Mermaid / KaTeX is added later, it must be paired
with `rehype-sanitize` (never `rehype-raw` unsanitized).

## 8. Testing strategy

Altitude: test contracts, avoid mocking internals.

| Layer | Target | Approach |
|---|---|---|
| Unit | `rfm` (parse / serialize / insertComment / id allocation) | **Primary focus.** Round-trip (md → parse → serialize → identical), offset insertion, graceful degrade on malformed input |
| Component | MarkdownView CriticMarkup rendering; SelectionPopover offset computation | jsdom + Testing Library; representative selection cases |
| Integration | server read / write / 409 / SSE | supertest against real files; simulate an external (AI) write → SSE fires |

## 9. Success criteria (v1 Done)

1. `npx inkmark open draft.md` renders the file nicely.
2. Selecting text within a paragraph lets you comment, saved as CriticMarkup in
   the `.md`.
3. When Claude edits the same `.md`, the viewer reflects it within a few hundred
   ms.
4. An AI `{>>..<<}` comment shows as a thread in the viewer and the human can
   reply.
5. Concurrent human + AI writes do not corrupt the file (409 → re-apply).

## 10. Open questions / future

- Theme system (v1 ships one theme; later: theme gallery like mdts).
- Multi-file tree + search (the natural v2).
- Blocking `open --json` handoff and/or MCP server for tighter AI loops.
- Richer anchoring (multi-block, code spans).
