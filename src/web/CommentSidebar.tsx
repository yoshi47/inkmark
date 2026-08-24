import { type JSX, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type CommentMeta,
  noteFor,
  noteFreeHighlight,
  noteSpan,
  parse,
  type Span,
  threadIds,
} from '../rfm/index.js';
import { hasTextSelection } from './textSelection.js';

type Filter = 'all' | 'highlights' | 'comments' | 'suggestions';

function removalPrompt(subject: string, replyCount: number): string {
  if (replyCount === 0) return `Delete this ${subject}?`;
  const replies = replyCount === 1 ? '1 reply' : `${String(replyCount)} replies`;
  return `Delete this ${subject} and its ${replies}?`;
}

interface SidebarProps {
  source: string;
  selectedId: string | null;
  /** Bumped per click and never reset — the sidebar dates tab presses against it. */
  selectSeq: number;
  /** Resolves to whether the document was written; a refused save keeps the editor open. */
  onEdit: (id: string, body: string) => Promise<boolean>;
  onReply: (parentId: string, body: string) => Promise<boolean>;
  onResolve: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveComment: (id: string) => void;
  onSelect: (id: string) => void;
  onSuggestion: (id: string, action: 'accept' | 'reject') => void;
}

export function CommentSidebar({
  source,
  selectedId,
  selectSeq,
  onEdit,
  onReply,
  onResolve,
  onRemove,
  onRemoveComment,
  onSelect,
  onSuggestion,
}: SidebarProps): JSX.Element {
  // Not a plain Filter: the press carries the selectSeq it was made at, so only
  // a mark click newer than the press may widen the filter. Unstamped, the
  // selection standing from before the press would keep pulling it back to All.
  const [chosen, setChosen] = useState<{ key: Filter; atSeq: number }>({ atSeq: 0, key: 'all' });
  // One at a time: an open editor holds unsaved text, and the sidebar has no
  // room to show several of them at once anyway.
  const [editingId, setEditingId] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const doc = parse(source);
  const comments = doc.endmatter.comments;

  function noteText(id: string): string {
    return noteFor(doc, id) ?? '';
  }

  function highlightText(id: string): string | null {
    return noteFreeHighlight(doc, id)?.inner ?? null;
  }

  // Root threads: endmatter entries with no re (reply-to) field, plus marks an
  // agent wrote inline without an endmatter entry — the same fallback the
  // suggestion list makes below, so a hand-written mark is still listed here.
  // Those carry no metadata, hence no Resolve. Notes belong in that fallback as
  // much as highlights do: the body renders one as a bare 💬, so leaving it
  // unlisted would put its text nowhere in the app at all.
  const roots: { id: string; meta: CommentMeta | null }[] = [
    ...Object.entries(comments)
      .filter(([, c]) => c.re === undefined)
      .map(([id, meta]) => ({ id, meta })),
    ...doc.spans.flatMap((s) =>
      (s.kind === 'highlight' || s.kind === 'comment') &&
      s.id !== undefined &&
      comments[s.id] === undefined
        ? [{ id: s.id, meta: null }]
        : [],
    ),
  ];

  // Collect suggestion IDs from both endmatter and inline spans
  const spanSuggestionIds = doc.spans
    .map((s) => s.id)
    .filter((id): id is string => id?.startsWith('s') === true);
  const suggestionIds = Array.from(
    new Set([...Object.keys(doc.endmatter.suggestions), ...spanSuggestionIds]),
  );

  // A note-free highlight is what separates the two kinds of root, so the same
  // call that picks the 🖍 label below also decides which tab an entry belongs to.
  const highlightRoots = roots.filter(({ id }) => highlightText(id) !== null);
  const commentRoots = roots.filter(({ id }) => highlightText(id) === null);

  // Membership, not classification: an id can answer to two tabs at once (a
  // hand-written mark numbered s1 is a root and a suggestion both), and asking
  // which single tab it belongs to would call such a row hidden while it sits
  // on screen.
  function rootsUnder(key: Filter): { id: string; meta: CommentMeta | null }[] {
    if (key === 'all') return roots;
    if (key === 'highlights') return highlightRoots;
    return key === 'comments' ? commentRoots : [];
  }
  function shows(key: Filter, id: string): boolean {
    if (rootsUnder(key).some((r) => r.id === id)) return true;
    return (key === 'all' || key === 'suggestions') && suggestionIds.includes(id);
  }

  // Widen only for an entry the sidebar really has — a mark whose id no row
  // answers to (a reply's, say) would otherwise throw the user's tab away and
  // still show them nothing.
  const selectedIsListed = selectedId !== null && shows('all', selectedId);

  // The selection that last forced the filter open, latched so the widening
  // outlives the click that caused it: re-deciding it every render would let
  // the next mark click — or removing the widened entry — pull the tab back out
  // from under the user. Set during render rather than from an effect so the
  // row is listed before the scroll effect below looks for it.
  const [widenedAt, setWidenedAt] = useState(0);
  if (
    selectedId !== null &&
    selectSeq > chosen.atSeq &&
    selectSeq > widenedAt &&
    selectedIsListed &&
    !shows(chosen.key, selectedId)
  ) {
    setWidenedAt(selectSeq);
  }
  const filter: Filter = widenedAt > chosen.atSeq ? 'all' : chosen.key;

  const shownRoots = rootsUnder(filter);
  const shownSuggestionIds = filter === 'all' || filter === 'suggestions' ? suggestionIds : [];

  // Not keyed on filter, though the rows it searches depend on it: a tab press
  // must not scroll, or filtering would drag the view back to the old selection.
  useEffect(() => {
    const aside = asideRef.current;
    if (selectedId === null || aside === null) return;
    for (const el of aside.querySelectorAll<HTMLElement>('[data-thread-id]')) {
      if (el.dataset['threadId'] === selectedId) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
  }, [selectedId, selectSeq]);

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: roots.length + suggestionIds.length },
    { key: 'highlights', label: 'Highlights', count: highlightRoots.length },
    { key: 'comments', label: 'Comments', count: commentRoots.length },
    { key: 'suggestions', label: 'Suggestions', count: suggestionIds.length },
  ];

  return (
    <aside className="comment-sidebar" ref={asideRef}>
      <div className="sidebar-filter" role="group" aria-label="Filter sidebar entries">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={tab.key === filter ? 'filter-tab active' : 'filter-tab'}
            aria-pressed={tab.key === filter}
            onClick={() => {
              setChosen({ atSeq: selectSeq, key: tab.key });
            }}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>
      {/* Only while filtered: an unmarked document has always shown an empty
          sidebar, and saying "nothing" there would read as something broken. */}
      {filter !== 'all' && shownRoots.length === 0 && shownSuggestionIds.length === 0 && (
        <p className="sidebar-empty">Nothing to show.</p>
      )}
      {shownRoots.map(({ id, meta }) => {
        const replies = Object.entries(comments).filter(([, r]) => r.re === id);
        const highlighted = highlightText(id);
        const classes = ['thread'];
        if (highlighted !== null) classes.push('highlight');
        if (meta?.resolved === true) classes.push('resolved');
        if (id === selectedId) classes.push('selected');
        return (
          <div key={id} className={classes.join(' ')} data-thread-id={id}>
            {editingId === id ? (
              <CommentEditor
                initial={noteText(id)}
                label="Edit this comment"
                submitLabel="Save"
                // Only an endmatter body can hold one: a note in the prose is part
                // of a paragraph, and a line break there would split it.
                multiline={noteSpan(doc, id) === null}
                onSubmit={async (body) => {
                  // save() reads an unchanged document as a mark gone astray and
                  // says so — not what closing an untouched editor should raise.
                  if (body === noteText(id).trim()) {
                    setEditingId(null);
                    return true;
                  }
                  const saved = await onEdit(id, body);
                  if (saved) setEditingId(null);
                  return saved;
                }}
                onCancel={() => {
                  setEditingId(null);
                }}
              />
            ) : (
              <ScrollLabel
                className="comment"
                onSelect={() => {
                  onSelect(id);
                }}
              >
                {highlighted !== null ? (
                  <>🖍 {highlighted}</>
                ) : meta === null ? (
                  // A note an agent wrote inline names no author, and a bare
                  // ": text" reads as one whose name went missing.
                  noteText(id)
                ) : (
                  <>
                    <b>{meta.by}</b>: {noteText(id)}
                  </>
                )}
              </ScrollLabel>
            )}
            {replies.map(([rid, r]) =>
              editingId === rid ? (
                <CommentEditor
                  key={rid}
                  initial={r.body ?? ''}
                  label={`Edit ${r.by}'s reply`}
                  submitLabel="Save"
                  multiline
                  onSubmit={async (body) => {
                    if (body === r.body?.trim()) {
                      setEditingId(null);
                      return true;
                    }
                    const saved = await onEdit(rid, body);
                    if (saved) setEditingId(null);
                    return saved;
                  }}
                  onCancel={() => {
                    setEditingId(null);
                  }}
                />
              ) : (
                <div className="reply" key={rid}>
                  <b>{r.by}</b>: {r.body}{' '}
                  <button
                    onClick={() => {
                      setEditingId(rid);
                    }}
                  >
                    Edit
                  </button>
                </div>
              ),
            )}
            <CommentEditor
              label="Write a reply"
              submitLabel="Send"
              placeholder="Reply…"
              multiline
              onSubmit={(body) => onReply(id, body)}
            />
            {noteFor(doc, id) !== null && editingId !== id && (
              <button
                onClick={() => {
                  setEditingId(id);
                }}
              >
                Edit
              </button>
            )}
            {meta !== null && meta.resolved !== true && (
              <button
                onClick={() => {
                  onResolve(id);
                }}
              >
                Resolve
              </button>
            )}
            {/* Removing a bare highlight costs nothing but its markup, so it
                goes unasked. Prose — a note, a reply — is gone for good, and
                the thread reaches deeper than the replies rendered above. */}
            <button
              onClick={() => {
                const doomed = threadIds(doc, id).size - 1;
                if (highlighted !== null && doomed === 0) {
                  onRemove(id);
                  return;
                }
                const subject = highlighted !== null ? 'highlight' : 'comment';
                if (!window.confirm(removalPrompt(subject, doomed))) return;
                if (highlighted !== null) {
                  onRemove(id);
                } else {
                  onRemoveComment(id);
                }
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
      {shownSuggestionIds.map((id) => {
        const span: Span | undefined = doc.spans.find((s) => s.id === id);
        let label: string;
        if (span === undefined) {
          label = id;
        } else if (span.kind === 'substitution') {
          label = `${span.oldText ?? ''} → ${span.newText ?? ''}`;
        } else if (span.kind === 'insertion') {
          label = `+ ${span.inner}`;
        } else if (span.kind === 'deletion') {
          label = `- ${span.inner}`;
        } else {
          label = id;
        }
        return (
          <div
            className={id === selectedId ? 'suggestion selected' : 'suggestion'}
            key={id}
            data-thread-id={id}
          >
            <ScrollLabel
              className="suggestion-label"
              onSelect={() => {
                onSelect(id);
              }}
            >
              {label}
            </ScrollLabel>
            <button
              onClick={() => {
                onSuggestion(id, 'accept');
              }}
            >
              Accept
            </button>
            <button
              onClick={() => {
                onSuggestion(id, 'reject');
              }}
            >
              Reject
            </button>
          </div>
        );
      })}
    </aside>
  );
}

// A div wearing the button role rather than a <button>: UA stylesheets make text
// inside a form control unselectable, and the comment's own words are the thing
// a reviewer most wants to copy. Firefox refuses to start a drag-selection in a
// <button> even with user-select: text, so styling the button was no way out.
function ScrollLabel({
  className,
  onSelect,
  children,
}: {
  className: string;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (hasTextSelection()) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Space scrolls the page, and a held key would fire on every repeat.
        e.preventDefault();
        if (e.repeat) return;
        onSelect();
      }}
    >
      {children}
    </div>
  );
}

/**
 * The box a reply is written in, and the one an existing comment is edited in.
 * A textarea rather than an input: the sidebar is 320px wide, and a single line
 * scrolls what the writer has already typed out of sight.
 *
 * `onCancel` is what tells the two roles apart — an editor closes on save, so it
 * must not also clear itself, and it is the only one Escape has anything to do in.
 */
function CommentEditor({
  initial = '',
  label,
  submitLabel,
  placeholder,
  multiline,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  label: string;
  submitLabel: string;
  placeholder?: string;
  multiline: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}): JSX.Element {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Back to auto first: scrollHeight only ever reports the taller of the two, so
  // measuring against the current height would let the box grow and never shrink.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    // scrollHeight stops at the padding, and the box is sized border-box, so the
    // border has to be added back or the last line sits 2px behind the edge.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${String(el.scrollHeight + border)}px`;
  }, [text]);
  const empty = text.trim().length === 0;
  function submit(): void {
    if (empty) return;
    // Clear only once the document is written: a save the server refused would
    // otherwise take the text with it, and there is nowhere to type it back from.
    void onSubmit(text.trim()).then((saved) => {
      if (saved && onCancel === undefined) setText('');
    });
  }
  return (
    <div className="reply-box">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel !== undefined) {
            onCancel();
            return;
          }
          if (e.key !== 'Enter') return;
          // Enter closing an IME conversion commits the candidate; it is not a send.
          if (e.nativeEvent.isComposing) return;
          if (multiline && e.shiftKey) return;
          e.preventDefault();
          submit();
        }}
      />
      {/* Disabled rather than quietly refusing: an empty comment is not a way to
          delete one, and a button that swallows the click reads as broken. */}
      <button disabled={empty} onClick={submit}>
        {submitLabel}
      </button>
      {onCancel !== undefined && <button onClick={onCancel}>Cancel</button>}
    </div>
  );
}
