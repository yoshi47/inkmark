---
name: inkmark
description: >-
  Read, reply to, resolve, and write inline review comments and suggested edits in a
  Markdown file using inkmark's format — CriticMarkup marks in the body plus a trailing
  YAML endmatter block. Use when a .md file contains marks like {==text==}{>>note<<}{#c1},
  {++insert++}{#s1}, {--delete--}{#s2}, {~~old~>new~~}{#s3}, or an endmatter block with
  `comments:` / `suggestions:` keys; or when asked to review a Markdown draft, list
  unresolved comments, reply to or resolve a comment, propose an edit as a suggestion,
  or open a document in inkmark. Triggers (EN): "review this draft", "reply to the
  comments", "what's unresolved", "resolve this thread", "suggest an edit", "open it in
  inkmark". Triggers (JP): 「この Markdown をレビューして」「コメントに返信して」
  「未解決のコメントある?」「コメントを解決して」「ここに提案を出して」「inkmark で開いて」.
  NOT for: ordinary Markdown editing when the file has no CriticMarkup marks, or for
  GitHub PR review comments.
allowed-tools: Read, Edit, Grep, Glob, Bash
---

# inkmark

inkmark keeps review comments **inside** the Markdown file: CriticMarkup marks in the
body (`{==text==}{>>note<<}{#c1}`), and a YAML **endmatter** block at the end of the file
holding who wrote what, when, and whether it is resolved.

You work on that file with `Read` / `Edit` / `Grep`. The full grammar, every field, and
the mistakes that break a document are in [REFERENCE.md](REFERENCE.md).

## 1. Do you even need the server?

Almost never. inkmark's viewer is for the human.

| What you want to do | What you need |
| --- | --- |
| Read comments, reply, add a comment or highlight, suggest an edit, resolve | Edit the `.md` file. **No server.** |
| Let a human watch it live in a browser | `inkmark open`, started in the background |

Do not reach for the CLI to read or write comments. It has no such subcommands —
`open`, `status`, `stop` are all it has.

## 2. Opening the browser view (only when asked)

1. Run `inkmark status` first.
   - Already serving **this** file → hand the human the URL and stop.
   - Serving a **different** file → do **not** open. inkmark tracks only one server in
     `~/.inkmark/server.json`; opening a second overwrites that record and leaves the
     first process running with no way to `inkmark stop` it. Tell the human, and only
     run `inkmark stop` first if they agree to close the other document.
2. `inkmark open <file.md>` never returns — it runs until SIGINT/SIGTERM. Start it with
   the Bash tool's `run_in_background: true`, **never in the foreground**, then confirm
   with `inkmark status`.
3. If `inkmark` is not on `PATH`: it is not published to npm, so it needs a clone plus
   `pnpm install && pnpm build`, then `pnpm link --global` (or `bin/` on `PATH`).
   **Do not install it yourself.** Say so, add that everything below still works without
   the viewer, and carry on.
4. Inside a clone with no `dist/`, run `pnpm build` first — `bin/inkmark` loads
   `dist/cli/index.js`.
5. Stop it with `inkmark stop`.

## 3. Read the existing comments

Read the whole file. Everything below the last `---` fence is the endmatter.

- `grep -n '{#c[0-9]' file.md` — where the comment marks sit in the body.
- `grep -n 'resolved:' file.md` — candidate open threads.

How to read what you find:

- A **thread root** is a `cN` entry with no `re:`. Its **replies** are the entries whose
  `re:` names it (replies of replies chain the same way).
- **Only roots carry `resolved`.** A reply never has it. Open = the root's `resolved` is
  not `true`.
- The endmatter is the truth about *who, when, resolved*. The body mark is the truth
  about *which text* a comment is attached to. Never infer one from the other.

## 4. Reply to a comment

Leave the body completely alone. Add one entry under the existing `comments:` map:

```yaml
  c7:
    by: AI
    re: c3
    at: 2026-08-26T10:00:00.000Z
    body: "ここは「ローカルファースト」の定義を先に置くほうが読みやすいです"
```

- **`body:` must be double-quoted.** See §8 — this one is not cosmetic. inkmark drops
  the quotes again on its next save when the text did not need them; that is
  normalisation, not damage.
- Write `by: AI`. The sidebar prints that name verbatim.
- Anchor your `Edit` on a short, unique `old_string` (the last entry's closing line).
  Never rewrite the whole endmatter block.

## 5. Leave a new comment or highlight

Wrap the text in the body **and** add a root entry to the endmatter. Both halves, always.

```markdown
これは {==ローカルファースト==}{>>この語の定義がまだ出てきていません<<}{#c8} なツールです。
```

```yaml
  c8:
    by: AI
    at: 2026-08-26T10:00:00.000Z
    resolved: false
```

A highlight with no note is the same shape without the `{>> <<}` part:
`{==some text==}{#c8}`.

## 6. Suggest an edit

```markdown
{++added text++}{#s1}
{--removed text--}{#s2}
{~~old wording~>new wording~~}{#s3}
```

…plus an entry under `suggestions:` carrying just `by` and `at`:

```yaml
  s1:
    by: AI
    at: 2026-08-26T10:00:00.000Z
```

Suggestion ids use the `s` series, numbered independently of `c`. A suggestion has no
`resolved` — accepting or rejecting it rewrites the body and removes the entry outright.

## 7. Resolve

Set the **root**'s `resolved: true`. Nothing else — the mark stays in the body, and the
replies are untouched.

## 8. Rules you must not break

1. **Double-quote every `body:` value.** An unquoted half-width colon —
   `body: 結論: これは危ない` — makes the YAML fail to parse, and inkmark then decides
   the block was never endmatter at all: **the entire block falls back into the document
   body**. Every comment disappears from the sidebar and the raw YAML renders as prose.
   No exception is thrown and the file still round-trips, so no amount of grepping will
   catch it.
2. **Mint ids from both places.** The next id is one more than the highest `cN` (or `sN`)
   found across *both* the body's `{#…}` marks *and* the endmatter keys. Comments and
   replies share one `c` series.
3. **Never put `<<}`, `==}`, `++}`, `--}`, or `~~}` inside text you insert** — mark text,
   notes, replies, suggestions. Any of them terminates the mark early.
4. **No line breaks inside a `{>> <<}` note.** It lives inside a paragraph; a newline
   splits it. The rule is the note's alone — the *marked span* may span several blocks, and
   then it carries blank lines and the block markers it crossed.
5. **Never overlap or nest marks.** A range that touches an existing mark is not markable.
6. **A fenced code block is all or nothing.** Wrap it whole, with `{==` and `==}` each on
   their own line, or let a larger mark swallow it whole. A mark that opens outside a fence
   and closes inside it (or the reverse) breaks the fence and turns the rest of the document
   into code:

   ````markdown
   {==
   ```ts
   const x = 1;
   ```
   ==}{>>this API is out of date<<}{#c9}
   ````

   Never put a mark *inside* a fence. The parser skips **plain, unindented, triple-backtick
   fences only** — inside a `~~~` fence, an indented one, or a four-backtick one it reads
   your `{==` as a real mark and mangles the code.
7. **Exactly one endmatter block, at the end of the file**, opened and closed by `---`.
   Do not append a second one. The parser can merge them, but the next save from the UI
   folds them into one and the diff becomes noise. (The parser also accepts an *unclosed*
   block, so a file missing its final `---` is not broken — but always write the closing
   fence yourself, because that is what a save produces.)
8. **Do not delete top-level keys** other than `comments:` / `suggestions:`. A `title:`
   or any other key is the author's, and inkmark preserves it across saves.
9. **A reply gets no body mark.** An entry with `re:` lives only in the endmatter.

## 9. Verify after editing

Re-read what you changed, then:

- Opener/closer counts match for each of `{==`/`==}`, `{++`/`++}`, `{--`/`--}`, `{~~`/`~~}`.
- Every `{#cN}` / `{#sN}` in the body has exactly one endmatter key. Going the other way,
  only **roots** need a mark: an entry with `re:` is a reply and correctly has none.
- The last two `^---$` lines in the file are the endmatter's own fence, with the YAML
  between them and nothing after. (Do not just count them — a document may use `---` as a
  horizontal rule in its prose.)
- If the viewer is open, the id you just wrote shows up in the sidebar (the server pushes
  file changes over SSE). Break rule 1 above and the sidebar goes **empty** — that is the
  fastest signal you have.

**Know the limit**: those are text checks, not a YAML parse. A file can pass every one of
them and still have lost its endmatter to rule 1. Inside a clone of inkmark, the real
check is to run the parser:

```bash
npx tsx -e "import('./src/rfm/index.ts').then(async (m) => {
  const { readFile } = await import('node:fs/promises');
  console.dir(m.parse(await readFile('<file>', 'utf8')).endmatter, { depth: null });
});"
```

(`tsx -e` compiles to CJS, so the import has to be a `.then()` — top-level `await`
fails to transform.)

If `comments` comes back empty on a file that visibly has comments, the endmatter fell
into the body — fix the YAML.

## 10. Worked example

Before:

```markdown
inkmark is a {==local-first==}{>>What does this mean here?<<}{#c1} viewer.

---
comments:
  c1:
    by: user
    at: 2026-08-26T09:00:00.000Z
    resolved: false
---
```

Reply to `c1`, then resolve it. The body does not change; the endmatter becomes:

```yaml
comments:
  c1:
    by: user
    at: 2026-08-26T09:00:00.000Z
    resolved: true
  c2:
    by: AI
    re: c1
    at: 2026-08-26T10:00:00.000Z
    body: "The document lives on your machine; you and the agent edit the same file."
```

`c2` because `c1` was the highest id in use. No mark was added for the reply, and only
the root's `resolved` moved.
