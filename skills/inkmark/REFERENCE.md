# inkmark file format reference

Everything inkmark stores lives in the `.md` file itself: CriticMarkup marks in the body,
and one YAML **endmatter** block at the end. This is the full grammar, plus the ways a
hand-edit breaks it.

## Marks

Every mark may carry a trailing `{#id}`. Comment ids use the `c` series, suggestion ids
the `s` series.

| Kind | Syntax | Meaning |
| --- | --- | --- |
| highlight | `{==text==}` | marked text, no note |
| comment | `{>>note<<}` | a note; normally written right after a highlight |
| insertion | `{++text++}` | suggest adding this text |
| deletion | `{--text--}` | suggest removing this text |
| substitution | `{~~old~>new~~}` | suggest replacing `old` with `new` |

The two shapes you write:

```markdown
{==some text==}{>>why this wording?<<}{#c1}   comment on a span
{==some text==}{#c1}                          highlight, no note
{++added++}{#s1}  {--removed--}{#s2}  {~~old~>new~~}{#s3}
```

A whole fenced code block is the one thing that can only be marked from the outside, with
the delimiters on their own lines:

````markdown
{==
```ts
const x = 1;
```
==}{>>this API is out of date<<}{#c9}
````

Wrapping accepts any CommonMark-shaped fence: backticks or tildes, three or more, with a
closer at least as long as the opener and indented up to three spaces.

Reading is narrower, and the gap matters. The tokenizer skips **plain, unindented,
triple-backtick fences only**, so a mark written inside a `~~~` fence, an indented fence, or
a four-backtick fence is parsed as a real mark and the code around it is mangled. Never put
a mark inside a fence — do not rely on the parser to ignore it.

### Text that cannot appear inside a mark

`<<}`, `==}`, `++}`, `--}`, `~~}`. Any of them ends the mark early, wherever it appears:
in the marked span, a note, a reply, or a suggestion. A `{>> <<}` note additionally may
not contain a line break, because it sits inside a paragraph.

## Endmatter

One block, at the very end of the file, opened and closed by a column-0 `---`. (The
closing fence is optional to the parser, but a save always writes it, so write it too.)

```markdown
body text …

---
comments:
  c1:
    by: user
    at: 2026-08-26T09:00:00.000Z
    resolved: false
  c2:
    by: AI
    re: c1
    at: 2026-08-26T10:00:00.000Z
    body: "The document lives on your machine."
suggestions:
  s1:
    by: AI
    at: 2026-08-26T10:00:00.000Z
---
```

### Fields

**Thread root** (`comments.cN`, no `re`) — the entry for a body mark:

| Field | Required | Notes |
| --- | --- | --- |
| `by` | yes | author name, printed verbatim in the sidebar. The UI writes `user`; an agent writes `AI` |
| `at` | yes | ISO-8601 timestamp. Unquoted is fine |
| `resolved` | yes in practice | `false` until resolved. Only roots carry it |
| `body` | no | an alternative place for the note when it is not inline (see below) |

**Reply** (`comments.cN` with `re`) — no body mark of its own:

| Field | Required | Notes |
| --- | --- | --- |
| `by`, `at` | yes | as above |
| `re` | yes | the id it answers. Replies can chain |
| `body` | yes | the reply text. **Always double-quote it.** inkmark unquotes it again on save when the text did not need quoting |
| `resolved` | never | a reply is not resolvable |

**Suggestion** (`suggestions.sN`) — `by` and `at` only. Accepting or rejecting a
suggestion rewrites the body and deletes the entry, so `resolved` is accepted by the type
but never used.

**Any other top-level key** (`title:`, a project's own front matter) is preserved
verbatim across saves. Never delete one.

### Id allocation

The next id is one greater than the highest number in that series found across **both**
the body's `{#…}` marks **and** the endmatter's `comments` + `suggestions` keys. Comments
and replies share a single `c` counter; suggestions have their own `s` counter.

### Where a note can live

Reading an existing file, a comment's text can sit in three places. inkmark takes the
first one it finds:

1. the `{>> <<}` span that carries the id — `{==x==}{>>note<<}{#c1}`
2. a `{>> <<}` span written immediately after the mark — `{==x==}{#c1}{>>note<<}`
   (it must touch the mark; a note further along the line is somebody else's)
3. the endmatter entry's own `body:`

Write shape 1. Read all three.

## How a hand-edit breaks a document

| Mistake | What happens |
| --- | --- |
| **`body:` left unquoted with a half-width colon** — `body: 結論: 危ない` | The YAML fails to parse, so inkmark decides the block was never endmatter. **The whole block falls into the document body**: every comment vanishes from the sidebar and raw YAML renders as prose. No error, and the file still round-trips |
| A second endmatter block appended | Parsed, but folded into one on the next UI save — a needlessly dirty diff |
| A reply given a body mark | It stays a reply — root-ness is `re:`, and `re:` is still there — but its text now renders in the prose too, and it joins the thread's marks, so deleting the thread cuts that text out of the document |
| `resolved` added to a reply | Meaningless; the sidebar never reads it |
| An id reused | Two marks answer to one entry; removal takes both |
| A mark placed inside a code fence | In a plain triple-backtick fence, invisible to the parser — the delimiters render as code. In a tilde, indented, or four-backtick fence, parsed as a real mark, mangling the code |
| `<<}` / `==}` / `++}` / `--}` / `~~}` inside marked text | The mark terminates early and the rest leaks into the document |

Only the first one is silent *and* catastrophic. Quote every `body:`.

## Verifying a file

Inside a clone of inkmark, run the real parser rather than trusting grep:

```bash
npx tsx -e "import('./src/rfm/index.ts').then(async (m) => {
  const { readFile } = await import('node:fs/promises');
  const d = m.parse(await readFile('<file>', 'utf8'));
  console.dir({ spans: d.spans.map((s) => [s.kind, s.id]), endmatter: d.endmatter }, { depth: null });
});"
```

`tsx -e` compiles to CJS, so the import must be a `.then()` — a top-level `await`
fails to transform.

`comments` coming back empty on a file that visibly has comments means the endmatter fell
into the body.

## CLI

Only for the human's browser view — there are no subcommands for reading or writing
comments.

| Command | What it does |
| --- | --- |
| `inkmark open <file.md>` | serves the file from the first free port at 4747 and opens a browser. **Runs until SIGINT/SIGTERM** — start it in the background |
| `inkmark status` | prints the URL, pid, and file of the running server, or `not running` |
| `inkmark stop` | SIGTERMs it |

State lives in `~/.inkmark/server.json`, and it holds **one** server. Opening a second
file overwrites the record and orphans the first process. Always check `status` first.

inkmark is not published to npm: the CLI needs a clone plus `pnpm install && pnpm build`,
then `pnpm link --global` or `bin/` on `PATH`.
