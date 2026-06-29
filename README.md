# inkmark

A local-first Markdown **viewer + commenting** tool for working with an AI agent.

Open a single `.md` file in your browser, read it, and leave inline comments and
suggested edits — and so can your AI agent. Comments are stored **inside the
Markdown file** as [CriticMarkup](http://criticmarkup.com/), so they stay
git-friendly, portable to other editors, and readable by an agent that just
opens the file.

> Status: **design phase**. See [`docs/design/2026-06-29-inkmark-design.md`](docs/design/2026-06-29-inkmark-design.md).

## Planned usage (v1)

```bash
npx inkmark open ./draft.md   # starts a local server and opens the browser
inkmark status
inkmark stop
```

## Why

Reviewing documents with an AI agent is clearer when feedback is anchored to
specific text (Google-Docs / Notion style) than in a chat back-and-forth.
Existing tools each miss something: `mo` / `mdts` are view-only; `roughdraft`
does commenting but with a different UI. inkmark is a personal take: a viewer I
like, with commenting that both a human and an AI share through the file itself.

## License

MIT (planned).
