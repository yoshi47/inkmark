# inkmark

A local-first Markdown **viewer + commenting** tool for working with an AI agent.

Open a single `.md` file in your browser, read it, and leave inline comments and
suggested edits — and so can your AI agent. Comments are stored **inside the
Markdown file** as [CriticMarkup](http://criticmarkup.com/), so they stay
git-friendly, portable to other editors, and readable by an agent that just
opens the file.

## Requirements

- Node.js >= 24
- pnpm

## Install & build

Not published to npm yet — run it from a clone:

```bash
git clone https://github.com/yoshi47/inkmark.git
cd inkmark
pnpm install
pnpm build
```

## Usage

```bash
./bin/inkmark open ./draft.md   # start a local server and open the browser
./bin/inkmark status            # show the running server (URL, pid, file)
./bin/inkmark stop              # stop the server
```

`open` serves the file on the first free port from `4747` and opens your
browser. The server watches the file: edits made on disk (by you, your editor,
or an AI agent) show up in the browser live. Press `Ctrl-C` to stop, or use
`inkmark stop` from another terminal.

### In the browser

- **Comment**: select text and click 💬 Comment in the popover to attach a note.
- **Highlight**: click 🖍 Highlight instead to just mark the text — no note, no
  prompt. Highlights are blue, commented text is yellow.
- **Sidebar**: comments, highlights and suggestions are listed on the right.
  Click an entry to scroll to its mark in the document; reply and resolve from
  the thread. Remove deletes a mark outright — a highlight leaves its text
  behind, a comment takes its note and replies with it.
- **Suggestions**: insertions (`{++ ++}`), deletions (`{-- --}`), and
  substitutions are rendered inline and can be accepted or rejected.

### With an AI agent

No API needed — the agent just edits the same `.md` file:

- highlight + comment: `{==some text==}{>>why this wording?<<}{#c1}`
- highlight only (no comment): `{==some text==}{#c1}`
- suggest an insertion: `{++added text++}{#s1}`
- suggest a deletion: `{--old text--}{#s2}`

The viewer picks up the change immediately, and comments you leave in the UI
are written back to the file for the agent to read.

## File format

Marks live inline in the Markdown body as CriticMarkup with an id tag.
Metadata (author, timestamp, replies, resolved state) lives in a YAML
endmatter block at the end of the file:

```markdown
This is a {==local-first==}{>>What does "local-first" mean here?<<}{#c1} viewer.

---
comments:
  c1:
    by: user
    at: 2026-06-30T00:00:00.000Z
    resolved: false
  c2:
    by: AI
    re: c1
    at: 2026-06-30T00:01:00.000Z
    body: The document lives on your machine; you and the AI edit the same file.
---
```

The file stays valid Markdown: other viewers show the marks as plain text, and
everything diffs cleanly in git.

## Development

```bash
pnpm dev:web      # Vite dev server for the web UI
pnpm test         # run tests (vitest)
pnpm lint         # eslint
pnpm typecheck    # tsc -b
pnpm format       # prettier --check
```

## License

MIT (planned).
