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
./bin/inkmark open ./draft.md            # start a local server and open the browser
./bin/inkmark open ./spec.md             # a second document, on the next free port
./bin/inkmark open ./draft.md --detach   # start it, print the URL, and return
./bin/inkmark status                     # list every running server (URL, pid, file)
./bin/inkmark stop ./draft.md            # stop one of them (by file or by port)
./bin/inkmark stop                       # stop all of them
./bin/inkmark stop 4747 --force          # stop one that is wedged and will not answer
./bin/inkmark forget 4747               # drop a record whose server is gone
./bin/inkmark wait ./draft.md           # block until somebody leaves a comment
./bin/inkmark live off                  # stop waking the agent at all
```

`open` serves the file on the first free port from `4747` and opens your
browser; `--port <n>` starts the scan somewhere else. The server watches the
file: edits made on disk (by you, your editor, or an AI agent) show up in the
browser live. Press `Ctrl-C` to stop, or use `inkmark stop` from another
terminal.

`--detach` starts the server in its own session and returns as soon as it is
serving, so it keeps running after the shell (or the AI agent session) that
started it goes away. Stop it with `inkmark stop`. What the detached server
writes goes to `~/.inkmark/logs/`.

You can keep several documents open at once — each gets its own port, and
`status` lists them all. Re-opening a file that is already being served just
reopens the browser on the existing server.

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
- **Images**: `![alt](./shot.png)` and `![alt](../assets/shot.png)` are resolved
  against the document's own directory, so images stored next to it — or beside
  it in the same repository — are displayed. Remote `https://` images work too.
  SVG is not served: a browser can open it as a page of its own, where its
  scripts would run with the same access to your file as inkmark itself.

### Live mode

By default the agent only reads your comments when you tell it to look. In live mode the
comment itself wakes it: the inkmark plugin registers a `Stop` hook that arms
`inkmark wait` in the background at the end of every turn, and that command returns the
moment somebody other than the agent leaves a comment. A waiting hook costs nothing — no
model turn, no blocked tool call.

- **Claude Code** wakes the session directly (an async hook with `asyncRewake`).
- **Codex** runs the same script, but a background hook cannot continue a turn there, so the
  comment is pushed back into the session with `codex queue`. Codex skips plugin hooks until
  you trust them: run `/hooks` once in a Codex session and approve the inkmark one.
- **Any other agent** (OpenCode, a script): run `inkmark wait <file.md>` and let it block.
  Exit 0 means comments were printed, exit 3 means the timeout ran out with nothing.

What counts as new is an entry under `comments:` that the agent has not been told about and
that carries `by: user` — the label the viewer writes for the human. Everything else is
ignored, including the agent's own reply under whatever name it uses, so a reply can never
wake the agent that wrote it. A comment that lands between two waits is not lost: the
reported ids live in `~/.inkmark/live/`.

The ライブ button in the viewer's header is the switch for **that document**, remembered in
`~/.inkmark/live/` next to the ids it has already reported — turning it off while reading one
draft leaves the others alone. The same switch from the CLI:

```bash
inkmark live off ./draft.md     # this document only
inkmark live on ./draft.md
inkmark live off                # master switch: nothing wakes, anywhere (config.yml `live:`)
inkmark live                    # print the master switch (add a path for one document)
```

While the master switch is off the header toggle is disabled rather than pretending a document
is armed. `INKMARK_LIVE=off` turns live mode off for one agent session without touching either
switch, and a waiter that is already running exits as soon as its document or the master switch
is turned off.

### Settings

The outline and comment column widths, the line-number gutter and whether the
outline starts open are one set of values for every document — not one per file.
They live in `~/.inkmark/config.yml` (or `$INKMARK_HOME/config.yml`), which the
browser controls write and you can also edit by hand:

```yaml
tocWidth: 240
commentWidth: 320
lineNumbers: false
showToc: true
live: true
```

A comment panel or an outline dragged in one window is still that width the next
time you open a different document. Below 1101px the outline is an overlay or a
drawer, so the width rule decides and `showToc` only applies when it is a column
of its own.

### With an AI agent

No API needed — the agent just edits the same `.md` file:

- highlight + comment: `{==some text==}{>>why this wording?<<}{#c1}`
- highlight only (no comment): `{==some text==}{#c1}`
- suggest an insertion: `{++added text++}{#s1}`
- suggest a deletion: `{--old text--}{#s2}`

The viewer picks up the change immediately, and comments you leave in the UI
are written back to the file for the agent to read.

### As an agent plugin

inkmark ships as a plugin for Claude Code, Codex, and OpenCode, so the agent already knows
the file format and the review workflow.

Claude Code:

```
/plugin marketplace add yoshi47/inkmark
/plugin install inkmark
```

Codex:

```bash
codex plugin marketplace add yoshi47/inkmark
codex plugin add inkmark@inkmark
```

OpenCode:

```bash
opencode plugin add 'github:yoshi47/inkmark#main::path:skills'
```

OpenCode has no manifest to read, so the plugin registers the skill itself — that is what
`skills/opencode-plugin.ts` is for. It lives in the skills package because OpenCode installs
the package its entrypoint resolves from, and a `::path:` selection carries nothing beside
the directory it names. `opencode plugin add` records the plugin in your global OpenCode
configuration.

Then just ask: "review this draft with inkmark", or "reply to the open comments in
draft.md". The plugin needs no server — it edits the same `.md` file. The `inkmark`
CLI only comes in when you want the browser view, which needs the clone-and-build
above.

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
