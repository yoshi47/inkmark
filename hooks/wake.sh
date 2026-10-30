#!/usr/bin/env bash
# Live mode: stay parked until somebody who is not the agent leaves a comment in an inkmark
# document, then wake the agent that is waiting on it.
#
# The plugin registers this as a Stop hook, so it runs at the end of every turn and returns
# immediately when there is nothing to wait for — inkmark not installed, no inkmark server
# under this project, live mode switched off, or another waiter already holding the document.
#
# Why the wait lives here and not in a Bash tool call: a tool call that blocks spends a model
# turn every time it times out and dies with the turn that started it. A background hook can
# outlive the turn, so the human commenting is the only thing that costs anything.
set -u

[ "${INKMARK_LIVE:-on}" = "off" ] && exit 0
command -v inkmark >/dev/null 2>&1 || exit 0

payload="$(cat 2>/dev/null || true)"
root="${CLAUDE_PROJECT_DIR:-$PWD}"
# A hook that outlives the session it belongs to must not sit there for days; the next Stop
# re-arms it, so lapsing after two idle hours costs one nudge, not the feature.
wait_seconds=7200

# Codex runs this hook in the background, where exit 2 is informational and cannot continue
# the turn. Hand the comment back to the session as a new user message instead, then wait for
# the next one — the reply's own Stop hook would start a second waiter, which the lock in
# `inkmark wait` turns away.
if [ -n "${PLUGIN_ROOT:-}" ]; then
  command -v codex >/dev/null 2>&1 || exit 0
  session="$(printf '%s' "$payload" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.session_id === "string") process.stdout.write(parsed.session_id);
      } catch {}
    });
  ' 2>/dev/null)"
  [ -n "$session" ] || exit 0
  while :; do
    out="$(inkmark wait --project "$root" --timeout "$wait_seconds")" || exit 0
    [ -n "$out" ] || exit 0
    codex queue --thread "$session" --resume --message "$out" >/dev/null 2>&1 || exit 0
  done
fi

# Claude Code: exit 2 is the wake-up, and stdout is what it shows the model.
out="$(inkmark wait --project "$root" --timeout "$wait_seconds")" || exit 0
[ -n "$out" ] || exit 0
printf '%s\n' "$out"
exit 2
